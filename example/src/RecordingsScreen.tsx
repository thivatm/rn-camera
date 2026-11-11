import { useCallback, useEffect, useState } from 'react';
import { Button, FlatList, StyleSheet, Text, View } from 'react-native';
import { RecordingUploads, type Recording } from '@thivatm/rn-camera';
import { uploadUrlProvider } from './config';
import { describeUpload } from './describeUpload';

export function RecordingsScreen() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    RecordingUploads.getRecordings().then((all) =>
      setRecordings(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    );
  }, []);

  useEffect(() => {
    refresh();
    const subscriptions = [
      // Progress updates the row in place; other events re-read everything.
      RecordingUploads.addListener('uploadProgress', (e) =>
        setRecordings((list) =>
          list.map((r) =>
            r.id === e.recordingId
              ? {
                  ...r,
                  recordedBytes: e.recordedBytes,
                  committedOffset: e.committedOffset,
                }
              : r
          )
        )
      ),
      RecordingUploads.addListener('uploadStateChange', refresh),
      RecordingUploads.addListener('uploadError', refresh),
    ];
    return () => subscriptions.forEach((s) => s.remove());
  }, [refresh]);

  const run = (action: () => Promise<void>) =>
    action()
      .then(() => setMessage(null))
      .catch((e) => setMessage(String(e)))
      .finally(refresh);

  return (
    <View style={styles.container}>
      <Button
        title="Resume uploads"
        onPress={() =>
          run(() => RecordingUploads.resumeUploads({ uploadUrlProvider }))
        }
      />
      {message && <Text style={styles.error}>{message}</Text>}
      <FlatList
        data={recordings}
        keyExtractor={(r) => r.id}
        ListEmptyComponent={
          <Text style={styles.empty}>No recordings yet.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.title}>
              {new Date(item.createdAt).toLocaleString()}
              {item.isLive ? ' · LIVE' : ''}
              {item.interrupted ? ' · interrupted' : ''}
              {item.stopReason ? ` · stopped: ${item.stopReason}` : ''}
            </Text>
            <Text>{describeUpload(item)}</Text>
            <View style={styles.actions}>
              {item.uploadState === 'failed' && (
                <Button
                  title="Retry"
                  onPress={() =>
                    run(() =>
                      RecordingUploads.retryUpload(item.id, {
                        uploadUrlProvider,
                      })
                    )
                  }
                />
              )}
              {!item.isLive && (
                <Button
                  title="Delete"
                  color="#d22"
                  onPress={() =>
                    run(() => RecordingUploads.deleteRecording(item.id))
                  }
                />
              )}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 8 },
  error: { color: '#d22', paddingHorizontal: 16 },
  empty: { textAlign: 'center', marginTop: 32, color: '#666' },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
  },
  title: { fontWeight: '600', marginBottom: 4 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
