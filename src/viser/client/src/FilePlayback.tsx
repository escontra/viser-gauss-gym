import { decodeAsync, decode } from "@msgpack/msgpack";
import { Message } from "./WebsocketMessages";
import { decompress } from "fflate";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ViewerContext } from "./ViewerContext";
import {
  ActionIcon,
  NumberInput,
  Paper,
  Select,
  Slider,
  Tooltip,
  useMantineTheme,
  SegmentedControl,
  Loader,
  Text,
} from "@mantine/core";
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
} from "@tabler/icons-react";

/** Download, decompress, and deserialize a file, which should be serialized
 * via msgpack and compressed via gzip. Also takes a hook for status updates. */
async function deserializeGzippedMsgpackFile<T>(
  fileUrl: string,
  setStatus: (status: { downloaded: number; total: number }) => void,
): Promise<T> {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch the file: ${response.statusText}`);
  }
  return new Promise<T>((resolve) => {
    const gzipTotalLength = parseInt(response.headers.get("Content-Length")!);
    if (typeof DecompressionStream === "undefined") {
      // Implementation without DecompressionStream.
      console.log("DecompressionStream is unavailable. Using fallback.");
      setStatus({ downloaded: 0.1 * gzipTotalLength, total: gzipTotalLength });
      response.arrayBuffer().then((buffer) => {
        setStatus({
          downloaded: 0.8 * gzipTotalLength,
          total: gzipTotalLength,
        });
        decompress(new Uint8Array(buffer), (error, result) => {
          setStatus({
            downloaded: 1.0 * gzipTotalLength,
            total: gzipTotalLength,
          });
          resolve(decode(result) as T);
        });
      });
    } else {
      // Stream: fetch -> gzip -> msgpack.
      let gzipReceived = 0;
      const progressStream = // Count number of (compressed) bytes.
        new TransformStream({
          transform(chunk, controller) {
            gzipReceived += chunk.length;
            setStatus({ downloaded: gzipReceived, total: gzipTotalLength });
            controller.enqueue(chunk);
          },
        });
      decodeAsync(
        response
          .body!.pipeThrough(progressStream)
          .pipeThrough(new DecompressionStream("gzip")),
      ).then((val) => resolve(val as T));
    }
  });
}

interface SerializedMessages {
  durationSeconds: number;
  messages: [number, Message][]; // (time in seconds, message).
  viserVersion: string;
}

export function PlaybackFromFile({ fileUrl }: { fileUrl: string }) {
  const viewer = useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current; // Get mutable once

  const darkMode = viewer.useGui((state) => state.theme.dark_mode);
  const [status, setStatus] = useState({ downloaded: 0.0, total: 0.0 });
  const [playbackSpeed, setPlaybackSpeed] = useState("1x");
  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState<SerializedMessages | null>(null);

  // Read robot view position from URL parameter (defaults to "top")
  const searchParams = new URLSearchParams(window.location.search);
  const robotViewPosition = searchParams.get("robotViewPosition") === "bottom" ? "bottom" : "top";

  // Segmented control for terrain vs gaussian splats (defaults to splats)
  const [visualizationMode, setVisualizationMode] = useState<"Mesh" | "Gaussian Splats">("Gaussian Splats");

  // Additional visibility for other scene nodes (not currently user-controllable)
  const showLinkHeights = false;
  const showCamera = true;

  // Track the current camera image for the top-left display
  const [cameraImageUrl, setCameraImageUrl] = useState<string | null>(null);
  const previousImageDataRef = useRef<Uint8Array | null>(null);

  // Instead of removing all of the existing scene nodes, we're just going to hide them.
  // This will prevent unnecessary remounting when messages are looped.
  function resetScene() {
    const sceneTreeState = viewer.useSceneTree.getState();
    Object.keys(sceneTreeState).forEach((key) => {
      if (key === "") return;
      const node = sceneTreeState[key];
      const nodeMessage = node?.message;
      if (
        nodeMessage !== undefined &&
        (nodeMessage.type !== "FrameMessage" || nodeMessage.props.show_axes)
      ) {
        // ^ We don't hide intermediate frames. These can be created
        // automatically by addSceneNodeMakerParents(), in which case there
        // will be no message to un-hide them.

        // Don't set visibility for tracked nodes - let the toggle override handle it
        const trackedNodes = ["/terrain", "/gs", "/link_heights", "/cam"];
        const isTrackedNode = trackedNodes.includes(key);

        viewer.sceneTreeActions.updateNodeAttributes(key, {
          visibility: isTrackedNode ? undefined : false,
          wxyz: [1, 0, 0, 0],
          position: [0, 0, 0],
        });
      } else if (node !== undefined) {
        // Still reset poses for frames.
        viewer.sceneTreeActions.updateNodeAttributes(key, {
          wxyz: [1, 0, 0, 0],
          position: [0, 0, 0],
        });
      }
    });
  }

  const [currentTime, setCurrentTime] = useState(0.0);

  const theme = useMantineTheme();

  // Apply visibility overrides when visualization mode or toggles are updated
  // Using overrideVisibility ensures messages don't override our toggle state
  useEffect(() => {
    if (recording === null) return;

    // Handle mutually exclusive terrain vs gaussian splats
    const showTerrain = visualizationMode === "Mesh";
    const showGaussianSplats = visualizationMode === "Gaussian Splats";

    // Update all tracked nodes
    const visibilityMap = {
      "/terrain": showTerrain,
      "/gs": showGaussianSplats,
      "/link_heights": showLinkHeights,
      "/cam": showCamera,
    };

    Object.entries(visibilityMap).forEach(([nodeName, visible]) => {
      const node = viewer.useSceneTree.getState()[nodeName];
      if (node !== undefined) {
        viewer.sceneTreeActions.updateNodeAttributes(nodeName, {
          overrideVisibility: visible, // true = visible, false = hidden
        });
      }
    });
  }, [visualizationMode, showLinkHeights, showCamera, viewer, recording]);

  // Monitor the /cam node for image updates and sync to the top-left display
  // Use a throttled approach: only check for updates periodically, not on every state change
  useEffect(() => {
    if (recording === null) return;

    const updateCameraImage = () => {
      const camNode = viewer.useSceneTree.getState()["/cam"];
      if (camNode?.message?.type === "CameraFrustumMessage") {
        const message = camNode.message;
        if (message.props._format !== null && message.props._image_data !== null) {
          const imageData = message.props._image_data;
          const format = message.props._format;

          // Only create a new blob URL if the image data has actually changed
          if (previousImageDataRef.current !== imageData) {
            previousImageDataRef.current = imageData;

            // Clean up the previous URL to prevent memory leaks
            setCameraImageUrl((prevUrl) => {
              if (prevUrl) {
                URL.revokeObjectURL(prevUrl);
              }
              // Create a new blob URL from the image data
              const newUrl = URL.createObjectURL(
                new Blob([imageData], {
                  type: "image/" + format,
                }),
              );
              return newUrl;
            });
          }
        } else {
          // Clear the image if no data
          if (previousImageDataRef.current !== null) {
            previousImageDataRef.current = null;
            setCameraImageUrl((prevUrl) => {
              if (prevUrl) {
                URL.revokeObjectURL(prevUrl);
              }
              return null;
            });
          }
        }
      }
    };

    // Update camera image at most 10 times per second instead of 120
    const interval = setInterval(updateCameraImage, 100);
    return () => clearInterval(interval);
  }, [viewer, recording]);

  // Cleanup camera image URL on unmount
  useEffect(() => {
    return () => {
      if (cameraImageUrl) {
        URL.revokeObjectURL(cameraImageUrl);
      }
    };
  }, [cameraImageUrl]);

  useEffect(() => {
    deserializeGzippedMsgpackFile<SerializedMessages>(fileUrl, setStatus).then(
      (data) => {
        console.log(
          "File loaded! Saved with Viser version:",
          data.viserVersion,
        );
        setRecording(data);
      },
    );
  }, []);

  const playbackMutable = useRef({ currentTime: 0.0, currentIndex: 0 });

  const updatePlayback = useCallback(() => {
    if (recording === null) return;
    const mutable = playbackMutable.current;

    // We have messages with times: [0.0, 0.01, 0.01, 0.02, 0.03]
    // We have our current time: 0.02
    // We want to get of a slice of all message _until_ the current time.
    if (mutable.currentIndex == 0) {
      // Reset the scene if sending the first message.
      resetScene();
    }
    for (
      ;
      mutable.currentIndex < recording.messages.length &&
      recording.messages[mutable.currentIndex][0] <= mutable.currentTime;
      mutable.currentIndex++
    ) {
      const message = recording.messages[mutable.currentIndex][1];
      viewerMutable.messageQueue.push(message);
    }

    // Apply visibility overrides after processing messages
    // This ensures the correct visibility is set even on initial load
    const showTerrain = visualizationMode === "Mesh";
    const showGaussianSplats = visualizationMode === "Gaussian Splats";
    const visibilityMap = {
      "/terrain": showTerrain,
      "/gs": showGaussianSplats,
      "/link_heights": showLinkHeights,
      "/cam": showCamera,
    };
    Object.entries(visibilityMap).forEach(([nodeName, visible]) => {
      const node = viewer.useSceneTree.getState()[nodeName];
      if (node !== undefined) {
        viewer.sceneTreeActions.updateNodeAttributes(nodeName, {
          overrideVisibility: visible,
        });
      }
    });

    if (mutable.currentTime >= recording.durationSeconds) {
      mutable.currentIndex = 0;
      mutable.currentTime = recording.messages[0][0];
    }
    setCurrentTime(mutable.currentTime);
  }, [recording, visualizationMode, showLinkHeights, showCamera, viewer]);

  useEffect(() => {
    const playbackMultiplier = parseFloat(playbackSpeed); // '0.5x' -> 0.5
    if (recording !== null && !paused) {
      let lastUpdate = Date.now();
      const interval = setInterval(() => {
        const now = Date.now();
        playbackMutable.current.currentTime +=
          ((now - lastUpdate) / 1000.0) * playbackMultiplier;
        lastUpdate = now;

        updatePlayback();
        if (
          playbackMutable.current.currentIndex === recording.messages.length &&
          recording.durationSeconds === 0.0
        ) {
          clearInterval(interval);
        }
      }, 1000.0 / 120.0);
      return () => clearInterval(interval);
    }
  }, [
    updatePlayback,
    recording,
    paused,
    playbackSpeed,
    viewerMutable.messageQueue,
    setCurrentTime,
  ]);

  // Pause/play with spacebar.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code === "Space") {
        setPaused(!paused);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [paused]); // Empty dependency array ensures this runs once on mount and cleanup on unmount

  const updateCurrentTime = useCallback(
    (value: number) => {
      if (value < playbackMutable.current.currentTime) {
        // Going backwards is more expensive...
        resetScene();
        playbackMutable.current.currentIndex = 0;
      }
      playbackMutable.current.currentTime = value;
      setCurrentTime(value);
      setPaused(true);
      updatePlayback();
    },
    [recording],
  );

  if (recording === null) {
    const loadingPercent = status.total > 0
      ? Math.round((status.downloaded / status.total) * 100)
      : 0;

    return (
      <div
        style={{
          position: "fixed",
          zIndex: 1,
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: darkMode ? theme.colors.dark[9] : "#fff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
        }}
      >
        <Loader size="xl" color={darkMode ? "blue" : "blue"} />
        <Text
          size="lg"
          fw={500}
          c={darkMode ? theme.colors.gray[4] : theme.colors.gray[7]}
        >
          Loading scene... {loadingPercent}%
        </Text>
      </div>
    );
  } else {
    return (
      <>
        {/* Camera image display - position based on robotViewPosition parameter */}
        {cameraImageUrl && (
          <Paper
            radius="xs"
            shadow="0.1em 0 1em 0 rgba(0,0,0,0.1)"
            style={{
              position: "fixed",
              ...(robotViewPosition === "bottom"
                ? { bottom: "6em", right: "1em" }
                : { top: "1em", left: "1em" }),
              zIndex: 1,
              padding: "0.5em",
              backgroundColor: darkMode ? theme.colors.dark[7] : "#fff",
            }}
          >
            <img
              src={cameraImageUrl}
              alt="Camera view"
              style={{
                display: "block",
                maxWidth: "320px",
                maxHeight: "240px",
                width: "auto",
                height: "auto",
              }}
            />
          </Paper>
        )}
        {/* Playback controls */}
        <Paper
          radius="xs"
          shadow="0.1em 0 1em 0 rgba(0,0,0,0.1)"
          style={{
            position: "fixed",
            bottom: "1em",
            left: "50%",
            transform: "translateX(-50%)",
            width: "25em",
            maxWidth: "95%",
            zIndex: 1,
            padding: "0.5em",
            display: recording.durationSeconds === 0.0 ? "none" : "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.375em",
          }}
        >
        <ActionIcon
          size="md"
          variant="subtle"
          onClick={() => setPaused(!paused)}
        >
          {paused ? (
            <IconPlayerPlayFilled height="1.125em" width="1.125em" />
          ) : (
            <IconPlayerPauseFilled height="1.125em" width="1.125em" />
          )}
        </ActionIcon>
        <SegmentedControl
          size="xs"
          value={visualizationMode}
          onChange={(value) => setVisualizationMode(value as "Mesh" | "Gaussian Splats")}
          data={["Mesh", "Gaussian Splats"]}
          styles={{
            root: { flexShrink: 0 },
          }}
        />
        <NumberInput
          size="xs"
          hideControls
          value={currentTime.toFixed(1)}
          step={0.01}
          styles={{
            wrapper: {
              width: "3.1em",
            },
            input: {
              padding: "0.2em",
              fontFamily: theme.fontFamilyMonospace,
              textAlign: "center",
            },
          }}
          onChange={(value) =>
            updateCurrentTime(
              typeof value === "number" ? value : parseFloat(value),
            )
          }
        />
        <Slider
          thumbSize={0}
          radius="xs"
          step={1e-4}
          style={{ flexGrow: 1 }}
          min={0}
          max={recording.durationSeconds}
          value={currentTime}
          onChange={updateCurrentTime}
          styles={{ thumb: { display: "none" } }}
        />
        <Tooltip zIndex={10} label={"Playback speed"} withinPortal>
          <Select
            size="xs"
            value={playbackSpeed}
            onChange={(val) => (val === null ? null : setPlaybackSpeed(val))}
            radius="xs"
            data={["0.5x", "1x", "2x", "4x", "8x"]}
            styles={{
              wrapper: { width: "3.25em" },
            }}
            comboboxProps={{ zIndex: 5, width: "5.25em" }}
          />
        </Tooltip>
      </Paper>
      </>
    );
  }
}
