import { useState } from 'react';
import {
    Platform,
    Pressable,
    StatusBar,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { CameraScreen } from './CameraScreen';
import { RecordingsScreen } from './RecordingsScreen';

type Tab = 'camera' | 'recordings';

export default function App() {
    const [tab, setTab] = useState<Tab>('camera');

    return (
        <View style={styles.container}>
            <View style={styles.screen}>
                {tab === 'camera' ? <CameraScreen /> : <RecordingsScreen />}
            </View>
            <View style={styles.tabs}>
                {(['camera', 'recordings'] as const).map((t) => (
                    <Pressable
                        key={t}
                        style={styles.tab}
                        onPress={() => setTab(t)}
                    >
                        <Text
                            style={[styles.tabText, tab === t && styles.active]}
                        >
                            {t === 'camera' ? 'Camera' : 'Recordings'}
                        </Text>
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    // Rough insets keep the example free of extra native dependencies; a real
    // app would use react-native-safe-area-context.
    container: {
        flex: 1,
        backgroundColor: 'white',
        paddingTop: Platform.OS === 'ios' ? 48 : StatusBar.currentHeight,
        paddingBottom: Platform.OS === 'ios' ? 24 : 0,
    },
    screen: { flex: 1 },
    tabs: {
        flexDirection: 'row',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: '#ccc',
    },
    tab: { flex: 1, padding: 14, alignItems: 'center' },
    tabText: { color: '#666' },
    active: { color: 'black', fontWeight: '600' },
});
