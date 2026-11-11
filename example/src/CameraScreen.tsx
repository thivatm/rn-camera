import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  RecordingError,
  StreamingCamera,
  requestPermissions,
  type CameraPosition,
  type PermissionStatus,
  type StreamingCameraRef,
} from '@thivatm/rn-camera';
import { uploadUrlProvider } from './config';

export function CameraScreen() {
  const camera = useRef<StreamingCameraRef>(null);
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null);
  const [position, setPosition] = useState<CameraPosition>('back');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // The Host App owns permission UI; the library only prompts.
    requestPermissions({ audio: true }).then(setPermissions);
  }, []);

  const start = async () => {
    setMessage(null);
    try {
      const result = await camera.current!.startRecording({
        uploadUrlProvider,
        metadata: { source: 'rn-camera-example' },
      });
      setRecordingId(result.recordingId);
    } catch (e) {
      setMessage(
        e instanceof RecordingError ? `${e.code}: ${e.message}` : String(e)
      );
    }
  };

  const stop = async () => {
    await camera.current?.stopRecording();
  };

  if (permissions && permissions.camera !== 'granted') {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>
          Camera permission is {permissions.camera}. Enable it in Settings.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StreamingCamera
        ref={camera}
        style={StyleSheet.absoluteFill}
        position={position}
        audio={permissions?.microphone === 'granted'}
        enablePinchToZoom
        enableTapToFocus
        onError={(e) => setMessage(`${e.code}: ${e.message}`)}
        onRecordingStopped={({ reason }) => {
          setRecordingId(null);
          setMessage(`Stopped (${reason}). Upload continues in Recordings.`);
        }}
      />
      {message && <Text style={styles.message}>{message}</Text>}
      <View style={styles.controls}>
        <Pressable
          style={styles.flip}
          disabled={recordingId !== null}
          onPress={() => setPosition((p) => (p === 'back' ? 'front' : 'back'))}
        >
          <Text style={styles.text}>Flip</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={recordingId ? 'Stop recording' : 'Record'}
          style={[styles.record, recordingId !== null && styles.recording]}
          onPress={recordingId ? stop : start}
        />
        <View style={styles.flip} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  text: { color: 'white', textAlign: 'center' },
  message: {
    color: 'white',
    backgroundColor: 'rgba(0,0,0,0.6)',
    margin: 16,
    padding: 8,
  },
  controls: {
    position: 'absolute',
    bottom: 32,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  flip: { width: 64, alignItems: 'center' },
  record: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 6,
    borderColor: 'white',
    backgroundColor: '#d22',
  },
  recording: { borderRadius: 12 },
});
