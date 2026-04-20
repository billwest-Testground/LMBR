/**
 * Mobile — New bid ingest screen.
 *
 * Purpose:  Field-ready intake for traders / buyers / trader_buyers on
 *           phones. Three entry points:
 *             - Pick a document (PDF/XLSX) via expo-document-picker
 *             - Snap a photo of a paper lumber takeoff via
 *               expo-image-picker (camera)
 *             - Import from photo library
 *           All three paths POST the file to the web app's /api/ingest
 *           endpoint (via EXPO_PUBLIC_LMBR_API_URL) and, on success,
 *           show the trader a confirmation panel summarizing the
 *           extraction and QA flags before they accept it.
 *
 * Inputs:   EXPO_PUBLIC_LMBR_API_URL, Supabase session token (mobile
 *           auth lands in a later prompt — for now we pass cookies if
 *           available, or the user authenticates through the web app
 *           first).
 * Outputs:  <View> + navigation to bid detail on accept.
 * Agent/API: POST /api/ingest (remote).
 * Imports:  react-native, expo-document-picker, expo-image-picker,
 *           expo-file-system, expo-router.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useRouter } from 'expo-router';

const API_URL =
  (process.env.EXPO_PUBLIC_LMBR_API_URL as string | undefined) ??
  'http://localhost:3000';

interface ExtractedLineItem {
  species: string;
  dimension: string;
  grade: string;
  length: string;
  quantity: number;
  unit: 'PCS' | 'MBF' | 'MSF';
  boardFeet: number;
  confidence: number;
  flags: string[];
  originalText: string;
}

interface ExtractionOutput {
  extractionConfidence: number;
  buildingGroups: Array<{
    buildingTag: string;
    phaseNumber: number | null;
    lineItems: ExtractedLineItem[];
  }>;
  totalLineItems: number;
  totalBoardFeet: number;
  flagsRequiringReview: string[];
}

interface QaSummary {
  errorCount: number;
  warningCount: number;
}

interface IngestResponse {
  bid_id: string;
  extraction: ExtractionOutput;
  qa_report: { pass: boolean; overallConfidence: number; summary: QaSummary };
}

export default function MobileNewBid() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [pending, setPending] = React.useState<null | {
    uri: string;
    name: string;
    mimeType: string;
  }>(null);
  const [result, setResult] = React.useState<IngestResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function pickDocument() {
    setError(null);
    const picked = await DocumentPicker.getDocumentAsync({
      type: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'image/*',
        'text/plain',
      ],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (picked.canceled || picked.assets.length === 0) return;
    const file = picked.assets[0];
    setPending({
      uri: file.uri,
      name: file.name ?? 'lumber-list',
      mimeType: file.mimeType ?? guessMime(file.name ?? ''),
    });
  }

  async function captureFromCamera() {
    setError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera permission denied', 'Enable camera access in Settings to capture lumber lists.');
      return;
    }
    const captured = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: true,
      aspect: undefined,
      exif: false,
    });
    if (captured.canceled || captured.assets.length === 0) return;
    const asset = captured.assets[0];
    setPending({
      uri: asset.uri,
      name: `scan-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
    });
  }

  async function pickFromLibrary() {
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo access denied', 'Enable photo library access in Settings.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0];
    setPending({
      uri: asset.uri,
      name: `photo-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
    });
  }

  async function submit() {
    if (!pending) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      // React Native's FormData ships a shim that accepts a
      // { uri, name, type } object in place of a browser Blob. The DOM
      // typing we get from @types/react-native / @types/node still
      // declares the standard Web API signature, so we cast through
      // `unknown` to silence the mismatch. The RN runtime accepts the
      // shape as-is and the Expo camera / document picker emit exactly
      // { uri, name, mimeType } — see apps/mobile/src/hooks/use-upload-picker.
      form.append('file', {
        uri: pending.uri,
        name: pending.name,
        type: pending.mimeType,
      } as unknown as Blob);

      const res = await fetch(`${API_URL}/api/ingest`, {
        method: 'POST',
        body: form,
      });

      const body = (await res.json().catch(() => ({}))) as
        | IngestResponse
        | { error?: string };

      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? 'Ingest failed');
      }
      setResult(body as IngestResponse);
      // Clean up the cached file once we have the response.
      try {
        await FileSystem.deleteAsync(pending.uri, { idempotent: true });
      } catch {}
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  function acceptAndContinue() {
    if (!result) return;
    router.push(`/bids/${result.bid_id}`);
  }

  function discard() {
    setPending(null);
    setResult(null);
    setError(null);
  }

  // ---- render ------------------------------------------------------------

  if (result) {
    return (
      <ScrollView className="flex-1 bg-bg-base">
        <View className="px-5 pb-10 pt-6">
          <Text className="text-label uppercase text-text-tertiary">Ingest complete</Text>
          <Text className="mt-1 text-h1 text-text-primary">
            {result.extraction.totalLineItems} lines extracted
          </Text>
          <Text className="mt-2 text-body text-text-secondary">
            {result.extraction.totalBoardFeet.toLocaleString()} BF across{' '}
            {result.extraction.buildingGroups.length} building{result.extraction.buildingGroups.length === 1 ? '' : 's'} ·{' '}
            {Math.round(result.qa_report.overallConfidence * 100)}% confidence
          </Text>

          {result.qa_report.summary.errorCount + result.qa_report.summary.warningCount > 0 && (
            <View className="mt-4 rounded-md border border-border-base bg-bg-subtle p-3">
              <Text className="text-caption text-text-tertiary">
                {result.qa_report.summary.errorCount} error(s) ·{' '}
                {result.qa_report.summary.warningCount} warning(s)
              </Text>
              <Text className="mt-1 text-body-sm text-text-secondary">
                Open the bid on the desktop console to review flagged lines.
              </Text>
            </View>
          )}

          {result.extraction.buildingGroups.map((group) => (
            <View
              key={group.buildingTag}
              className="mt-4 rounded-md border border-border-base bg-bg-surface p-3"
            >
              <Text className="text-h4 text-text-primary">{group.buildingTag}</Text>
              <Text className="text-caption text-text-tertiary">
                {group.lineItems.length} lines
              </Text>
            </View>
          ))}

          <View className="mt-6 flex-row gap-3">
            <PrimaryButton onPress={acceptAndContinue} label="Open bid" />
            <GhostButton onPress={discard} label="Start over" />
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1 bg-bg-base">
      <View className="px-5 pb-10 pt-6">
        <Text className="text-label uppercase text-text-tertiary">New bid</Text>
        <Text className="mt-1 text-h1 text-text-primary">Ingest a lumber list</Text>
        <Text className="mt-2 text-body text-text-secondary">
          Pick a file, snap a photo of a paper takeoff, or import from your
          photo library. LMBR extracts every line item and flags anything
          ambiguous for review.
        </Text>

        <View className="mt-6 gap-3">
          <ActionCard
            title="Pick a document"
            description="PDF, Excel, or text — from Files, iCloud, or Drive"
            onPress={pickDocument}
            disabled={loading}
          />
          <ActionCard
            title="Capture from camera"
            description="Snap a photo of a paper lumber takeoff"
            onPress={captureFromCamera}
            disabled={loading}
          />
          <ActionCard
            title="Choose from photos"
            description="Import an existing photo from your library"
            onPress={pickFromLibrary}
            disabled={loading}
          />
        </View>

        {pending && (
          <View className="mt-6 rounded-md border border-border-base bg-bg-surface p-4">
            <Text className="text-label uppercase text-text-tertiary">Ready to ingest</Text>
            <Text className="mt-1 text-body text-text-primary">{pending.name}</Text>
            <Text className="mt-0.5 text-caption text-text-tertiary">
              {pending.mimeType}
            </Text>

            <View className="mt-4 flex-row gap-3">
              <PrimaryButton onPress={submit} label="Ingest" loading={loading} />
              <GhostButton onPress={discard} label="Cancel" />
            </View>
          </View>
        )}

        {error && (
          <View className="mt-4 rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2">
            <Text className="text-body-sm text-semantic-error">{error}</Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

// ---- local components ------------------------------------------------------

function ActionCard({
  title,
  description,
  onPress,
  disabled,
}: {
  title: string;
  description: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="rounded-md border border-border-base bg-bg-surface px-4 py-4 active:bg-bg-elevated"
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <Text className="text-h4 text-text-primary">{title}</Text>
      <Text className="mt-1 text-body-sm text-text-secondary">{description}</Text>
    </Pressable>
  );
}

function PrimaryButton({
  onPress,
  label,
  loading,
}: {
  onPress: () => void;
  label: string;
  loading?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      className="flex-row items-center justify-center gap-2 rounded-sm bg-accent-primary px-5 py-2.5 active:bg-accent-secondary"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loading ? (
        <ActivityIndicator size="small" color="#0A0E0C" />
      ) : (
        <Text className="text-body font-semibold text-text-inverse">{label}</Text>
      )}
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

// ---- helpers ---------------------------------------------------------------

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.xlsx'))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}
