import { StyleSheet, Text, View } from 'react-native';

// 雛形の仮の画面。ホーム（docs/screens.md 3章）を作るときに置き換える。
export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>わりかん生活</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  title: { fontSize: 24, fontWeight: '700', color: '#FC75A4' },
});
