import {
  Platform,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputInstance,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
} from "react-native";

import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useScaledTextRole } from "../../lib/useScaledTextRole";

import { cn } from "../../lib/cn";

export type AppTextProps = RNTextProps & {
  readonly className?: string;
  readonly textRole?: keyof typeof MOBILE_TYPOGRAPHY;
};

/**
 * Thin wrapper around RN Text with default font-family and foreground color.
 * Uses Uniwind className — no manual style parsing.
 */
export function AppText({ className, textRole, style, ...props }: AppTextProps) {
  const typography = useScaledTextRole(textRole ?? "body");
  return (
    <RNText
      className={cn("font-sans text-foreground", className)}
      style={[textRole ? typography : undefined, style]}
      selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
      {...props}
    />
  );
}

export type AppTextInputProps = Omit<RNTextInputProps, "placeholderTextColor"> & {
  readonly className?: string;
  readonly ref?: React.Ref<TextInputInstance>;
};

export function AppTextInput({ className, ref, ...props }: AppTextInputProps) {
  return (
    <RNTextInput
      ref={ref}
      className={cn(
        "min-h-13.5 rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground",
        className,
      )}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName={"accent-focus/32"}
      cursorColorClassName={"accent-focus"}
      selectionHandleColorClassName={Platform.OS === "android" ? "accent-focus" : undefined}
      {...props}
    />
  );
}
