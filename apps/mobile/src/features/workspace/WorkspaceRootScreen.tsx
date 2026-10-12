import { HomeRouteScreen } from "../home/HomeRouteScreen";

/**
 * The Home route. Android shows chats and pull requests as tabs (WorkspaceRootScreen.android);
 * upstream's iOS tab bar needs react-native-screens 5, so iOS keeps ViewCode's home and opens
 * the pull request list from its header.
 */
export function WorkspaceRootScreen() {
  return <HomeRouteScreen />;
}
