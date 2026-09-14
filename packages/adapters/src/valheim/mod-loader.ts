// Maintainer release: https://thunderstore.io/c/valheim/p/denikson/BepInExPack_Valheim/
export const BEPINEX_DOWNLOAD = {
  url: 'https://gcdn.thunderstore.io/live/repository/packages/denikson-BepInExPack_Valheim-5.4.2350.zip',
  sha256: '37a91c000b4e88f2ed7a4bd7d812239852d2e36cbf0ff0a9f5faacfba46b105f',
  strip: 1,
};

// The upstream launch script hardcodes the world and password. Apply its
// loader environment directly so the panel's actual settings reach Valheim.
export const BEPINEX_LAUNCH = [
  '/usr/bin/env',
  'DOORSTOP_ENABLED=1',
  'DOORSTOP_TARGET_ASSEMBLY=/home/container/BepInEx/core/BepInEx.Preloader.dll',
  'LD_PRELOAD=/home/container/doorstop_libs/libdoorstop_x64.so',
];
