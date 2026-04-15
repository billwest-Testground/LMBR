/**
 * ScanCapture — expo-camera capture surface.
 *
 * Purpose:  Renders the camera preview, capture button, and post-capture
 *           confirmation step before uploading to /api/ingest.
 * Inputs:   onCaptured callback.
 * Outputs:  <View>.
 * Agent/API: ingest-agent (vision).
 * Imports:  expo-camera, react-native.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { View, Text } from 'react-native';

export function ScanCapture(_props: { onCaptured?: (uri: string) => void }) {
  return (
    <View>
      <Text>Not implemented: ScanCapture</Text>
    </View>
  );
}
