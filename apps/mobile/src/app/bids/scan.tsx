/**
 * Mobile — vendor scan-back capture.
 *
 * Purpose:  Camera-driven capture surface used by Buyers and Trader-Buyers
 *           when a vendor returns a printed lumber list with handwritten
 *           prices. The screen walks the user through capture → crop →
 *           review → submit, then hands the resulting JPEG to the vendor
 *           bid extraction endpoint. This scaffolds the capture UX; the
 *           actual /api/extract vendor-bid wiring lands in PROMPT 05.
 *
 * Inputs:   camera permission + capture asset.
 * Outputs:  <View>.
 * Agent/API: /api/extract (vendor bid OCR) — wired in PROMPT 05.
 * Imports:  expo-image-picker, expo-image-manipulator, react-native,
 *           expo-router.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  ActivityIndicator,
  Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useRouter } from 'expo-router';

type Phase = 'idle' | 'review' | 'submitting';

export default function MobileScanScreen() {
  const router = useRouter();
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [imageUri, setImageUri] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function startCapture() {
    setError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera permission denied', 'Enable camera access in Settings.');
      return;
    }
    const captured = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
      allowsEditing: true,
      exif: false,
    });
    if (captured.canceled || captured.assets.length === 0) return;

    // Normalize — downscale to max 2000px on the long edge so upload is fast.
    const asset = captured.assets[0];
    try {
      const normalized = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 2000 } }],
        {
          compress: 0.85,
          format: ImageManipulator.SaveFormat.JPEG,
        },
      );
      setImageUri(normalized.uri);
    } catch {
      setImageUri(asset.uri);
    }
    setPhase('review');
  }

  async function recapture() {
    setImageUri(null);
    setPhase('idle');
  }

  async function submit() {
    if (!imageUri) return;
    setPhase('submitting');
    setError(null);

    // Vendor extract endpoint is built in PROMPT 05. For now we show an
    // affordance and route back to the bid list. Keeping the capture +
    // normalization + preview flow wired so PROMPT 05 only needs to wire
    // the network call.
    setTimeout(() => {
      setPhase('idle');
      setImageUri(null);
      Alert.alert(
        'Scan captured',
        'Vendor-bid OCR extraction ships in a later build.',
        [{ text: 'OK', onPress: () => router.back() }],
      );
    }, 400);
  }

  return (
    <View className="flex-1 bg-bg-base">
      <View className="px-5 pb-10 pt-6">
        <Text className="text-label uppercase text-text-tertiary">Vendor scan-back</Text>
        <Text className="mt-1 text-h1 text-text-primary">Capture a priced list</Text>
        <Text className="mt-2 text-body text-text-secondary">
          Snap a photo of the vendor's printed lumber list with their
          handwritten prices. LMBR will OCR the response and match each
          priced line back to the original request.
        </Text>
      </View>

      {phase === 'idle' && (
        <View className="mx-5 flex-1 items-center justify-center rounded-lg border border-dashed border-border-base bg-bg-surface px-6 py-10">
          <Text className="text-body text-text-secondary">
            Position the printed list flat and well lit. Include every line
            and any notes in the margins.
          </Text>
          <View className="mt-6">
            <PrimaryButton label="Open camera" onPress={startCapture} />
          </View>
        </View>
      )}

      {phase === 'review' && imageUri && (
        <View className="mx-5 flex-1 rounded-lg border border-border-base bg-bg-surface p-4">
          <Image
            source={{ uri: imageUri }}
            className="h-[360px] w-full rounded-sm"
            resizeMode="cover"
            accessibilityLabel="Captured vendor list"
          />
          <View className="mt-4 flex-row gap-3">
            <PrimaryButton label="Submit scan" onPress={submit} />
            <GhostButton label="Retake" onPress={recapture} />
          </View>
        </View>
      )}

      {phase === 'submitting' && (
        <View className="mx-5 flex-1 items-center justify-center rounded-lg border border-border-base bg-bg-surface p-6">
          <ActivityIndicator size="large" color="#1DB87A" />
          <Text className="mt-3 text-body text-text-secondary">
            Extracting vendor prices…
          </Text>
        </View>
      )}

      {error && (
        <View className="mx-5 mt-4 rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2">
          <Text className="text-body-sm text-semantic-error">{error}</Text>
        </View>
      )}
    </View>
  );
}

function PrimaryButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-center gap-2 rounded-sm bg-accent-primary px-5 py-2.5 active:bg-accent-secondary"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text className="text-body font-semibold text-text-inverse">{label}</Text>
    </Pressable>
  );
}

function GhostButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-center gap-2 rounded-sm border border-border-strong px-5 py-2.5 active:bg-bg-elevated"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text className="text-body text-text-primary">{label}</Text>
    </Pressable>
  );
}
