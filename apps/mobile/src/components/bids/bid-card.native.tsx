/**
 * BidCard (native) — mobile bid row.
 *
 * Purpose:  Touch-friendly bid card for the mobile pipeline list.
 * Inputs:   { bid: Bid }.
 * Outputs:  <Pressable> JSX.
 * Agent/API: none.
 * Imports:  react-native, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { View, Text } from 'react-native';
import type { Bid } from '@lmbr/types';

export function BidCardNative(_props: { bid: Bid }) {
  return (
    <View>
      <Text>Not implemented: BidCardNative</Text>
    </View>
  );
}
