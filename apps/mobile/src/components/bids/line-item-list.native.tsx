/**
 * LineItemListNative — FlatList-backed line items for mobile.
 *
 * Purpose:  Renders a bid's line items in a scrollable list optimized for
 *           mobile, with inline QA issue indicators.
 * Inputs:   { lineItems: LineItem[] }.
 * Outputs:  FlatList JSX.
 * Agent/API: none.
 * Imports:  react-native, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { View, Text } from 'react-native';
import type { LineItem } from '@lmbr/types';

export function LineItemListNative(_props: { lineItems: LineItem[] }) {
  return (
    <View>
      <Text>Not implemented: LineItemListNative</Text>
    </View>
  );
}
