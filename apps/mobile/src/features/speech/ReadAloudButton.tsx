import { Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { speakableText } from "./speakableText";
import { speak, stopSpeaking, useSpeakingKey } from "./speech";

/** Speech keys name the thread first, so leaving a thread can stop only its own reading. */
export function readAloudKey(threadKey: string, messageId: string): string {
  return `${threadKey}\0${messageId}`;
}

export function ReadAloudButton(props: {
  readonly speechKey: string;
  readonly markdown: string;
  readonly tintColor: ColorValue;
}) {
  const speaking = useSpeakingKey() === props.speechKey;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speaking ? "Stop reading" : "Read aloud"}
      hitSlop={8}
      onPress={() =>
        speaking ? stopSpeaking() : speak(props.speechKey, speakableText(props.markdown))
      }
      style={({ pressed }) => ({
        width: 28,
        height: 28,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name={speaking ? "stop.fill" : "speaker.wave.2"}
        size={13}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
}
