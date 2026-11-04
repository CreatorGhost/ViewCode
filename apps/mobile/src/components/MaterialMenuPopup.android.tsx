import {
  Box,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  Host,
  RNHostView,
  Text,
} from "@expo/ui/jetpack-compose";
import { defaultMinSize, padding, size, width } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";
import { resolveScaledTextRole } from "../lib/appearancePreferences";

import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { useAppearancePreferences } from "../lib/appearancePreferencesContext";
import type { MaterialMenuPopupProps } from "./MaterialMenuPopup";
import { FONT_FAMILIES } from "../lib/fontFamilies";
import { MENU_CORNER_RADIUS } from "./menuCornerRadius";
import { isAppSymbolName, SymbolView, type AppSymbolName } from "./AppSymbol";

function MenuIcon(props: {
  readonly name: AppSymbolName;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}) {
  const { iconSize } = useAndroidControlSizing();
  return (
    <RNHostView matchContents modifiers={[size(iconSize, iconSize)]}>
      <View
        style={{ width: iconSize, height: iconSize }}
        importantForAccessibility="no-hide-descendants"
      >
        <SymbolView
          name={props.name}
          size={iconSize}
          type="monochrome"
          tintColorClassName={
            props.disabled
              ? "accent-icon-subtle"
              : props.destructive
                ? "accent-danger-foreground"
                : "accent-foreground"
          }
        />
      </View>
    </RNHostView>
  );
}

/** Native popup positioned at the original trigger, outside virtualized rows. */
export function MaterialMenuPopup(props: MaterialMenuPopupProps) {
  const { appearance, themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale, menuItemHeight } = useAndroidControlSizing();
  const body = resolveScaledTextRole("body", appearance.baseFontSize);
  const caption = resolveScaledTextRole("caption", appearance.baseFontSize);
  const foreground = colors["--color-foreground"];
  const muted = colors["--color-foreground-muted"];
  // Compose falls back to Roboto; name the app's face so menus match the screen behind them.
  const regular = FONT_FAMILIES.regular;
  const medium = FONT_FAMILIES.medium;
  // A fixed native item height clips wrapped labels; a minimum lets each row grow.
  const itemModifiers = [width(props.menuWidth), defaultMinSize({ minHeight: menuItemHeight })];
  const items = (
    <>
      {props.parent ? (
        <DropdownMenuItem onClick={props.onBack} modifiers={itemModifiers}>
          <DropdownMenuItem.LeadingIcon>
            <MenuIcon name="arrow.left" />
          </DropdownMenuItem.LeadingIcon>
          <DropdownMenuItem.Text>
            <Text
              color={foreground}
              style={{ typography: "bodyLarge", ...body, fontFamily: medium }}
            >
              {props.parent.title}
            </Text>
          </DropdownMenuItem.Text>
        </DropdownMenuItem>
      ) : props.title ? (
        <Text
          color={muted}
          style={{ typography: "bodySmall", ...caption, fontFamily: medium }}
          modifiers={[padding(16 * scale, 8 * scale, 16 * scale, 8 * scale)]}
        >
          {props.title}
        </Text>
      ) : null}
      {props.actions.map((action, index) => (
        <DropdownMenuItem
          key={action.id ?? `${index}-${action.title}`}
          enabled={!action.attributes?.disabled}
          modifiers={itemModifiers}
          onClick={() => props.onPress(action)}
        >
          {action.image && isAppSymbolName(action.image) ? (
            <DropdownMenuItem.LeadingIcon>
              <MenuIcon
                name={action.image}
                destructive={action.attributes?.destructive}
                disabled={action.attributes?.disabled}
              />
            </DropdownMenuItem.LeadingIcon>
          ) : null}
          <DropdownMenuItem.Text>
            <Column>
              <Text
                style={{ typography: "bodyLarge", ...body, fontFamily: regular }}
                color={
                  action.attributes?.disabled
                    ? muted
                    : action.attributes?.destructive
                      ? colors["--color-danger-foreground"]
                      : foreground
                }
              >
                {action.title}
              </Text>
              {action.subtitle ? (
                <Text
                  color={muted}
                  style={{ typography: "bodySmall", ...caption, fontFamily: regular }}
                >
                  {action.subtitle}
                </Text>
              ) : null}
            </Column>
          </DropdownMenuItem.Text>
          {(action.subactions?.length ?? 0) > 0 ? (
            <DropdownMenuItem.TrailingIcon>
              <MenuIcon name="chevron.right" disabled={action.attributes?.disabled} />
            </DropdownMenuItem.TrailingIcon>
          ) : action.state === "on" ? (
            <DropdownMenuItem.TrailingIcon>
              <MenuIcon name="checkmark" disabled={action.attributes?.disabled} />
            </DropdownMenuItem.TrailingIcon>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
  if (props.inline) {
    return (
      <Host
        colorScheme={themeAppearance}
        ignoreSafeAreaKeyboardInsets
        matchContents
        style={{ width: props.menuWidth }}
      >
        <Column>{items}</Column>
      </Host>
    );
  }
  return (
    <Host
      colorScheme={themeAppearance}
      ignoreSafeAreaKeyboardInsets
      style={{
        position: "absolute",
        left: props.anchor.x,
        top: props.anchor.y,
        width: props.anchor.width,
        height: props.anchor.height,
      }}
    >
      <DropdownMenu
        expanded
        onDismissRequest={props.onClose}
        color={colors["--color-card"]}
        cornerRadius={MENU_CORNER_RADIUS}
      >
        <DropdownMenu.Trigger>
          <Box modifiers={[size(props.anchor.width, props.anchor.height)]} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>{items}</DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}
