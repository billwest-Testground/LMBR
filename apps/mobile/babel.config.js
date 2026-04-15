/**
 * LMBR.ai mobile — Babel config.
 *
 * Purpose:  Wires babel-preset-expo + NativeWind (Tailwind for RN) + the
 *           Reanimated plugin for the LMBR.ai Expo app.
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: ['react-native-reanimated/plugin'],
  };
};
