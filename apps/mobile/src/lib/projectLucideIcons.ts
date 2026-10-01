import type { Icon } from "@tabler/icons-react-native/types";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconCloudCog from "@tabler/icons-react-native/IconCloudCog";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconDatabase from "@tabler/icons-react-native/IconDatabase";
import IconDeviceDesktop from "@tabler/icons-react-native/IconDeviceDesktop";
import IconDeviceGamepad2 from "@tabler/icons-react-native/IconDeviceGamepad2";
import IconDeviceMobile from "@tabler/icons-react-native/IconDeviceMobile";
import IconFlask2 from "@tabler/icons-react-native/IconFlask2";
import IconFolderCode from "@tabler/icons-react-native/IconFolderCode";
import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconMusic from "@tabler/icons-react-native/IconMusic";
import IconPackage from "@tabler/icons-react-native/IconPackage";
import IconPhoto from "@tabler/icons-react-native/IconPhoto";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconShieldCheck from "@tabler/icons-react-native/IconShieldCheck";
import IconShoppingBag from "@tabler/icons-react-native/IconShoppingBag";
import IconSitemap from "@tabler/icons-react-native/IconSitemap";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStack3 from "@tabler/icons-react-native/IconStack3";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconWorld from "@tabler/icons-react-native/IconWorld";

/**
 * Tabler stand-ins for web's popular Lucide project icons (projectIconOptions.ts).
 * ponytail: only the picker's popular set; a searched Lucide icon outside it
 * still falls back to the coloured monogram. Add names here when that matters.
 */
const PROJECT_LUCIDE_ICONS: Readonly<Record<string, Icon>> = {
  "folder-code": IconFolderCode,
  "code-2": IconCode,
  code: IconCode,
  terminal: IconTerminal2,
  "globe-2": IconWorld,
  globe: IconWorld,
  server: IconServer,
  database: IconDatabase,
  bot: IconRobot,
  sparkles: IconSparkles,
  smartphone: IconDeviceMobile,
  monitor: IconDeviceDesktop,
  "cloud-cog": IconCloudCog,
  package: IconPackage,
  "book-open": IconBook,
  "flask-conical": IconFlask2,
  "shield-check": IconShieldCheck,
  rocket: IconRocket,
  "gamepad-2": IconDeviceGamepad2,
  music: IconMusic,
  image: IconPhoto,
  "shopping-bag": IconShoppingBag,
  "git-branch": IconGitBranch,
  workflow: IconSitemap,
  wrench: IconTool,
  "layers-3": IconStack3,
};

export function projectLucideIcon(name: string): Icon | undefined {
  return PROJECT_LUCIDE_ICONS[name];
}
