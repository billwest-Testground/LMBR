/**
 * LMBR.ai mobile — Metro config.
 *
 * Purpose:  Extends Expo's default Metro config with NativeWind (Tailwind
 *           for React Native) source-transform wrapping so the design
 *           tokens flow into the LMBR.ai Expo app.
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './src/app/global.css' });
