import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "~/lib/utils";

export function MarkdownCodeBlockFrame({
  as: Wrapper = "div",
  language,
  fenceTitle,
  wrapped = true,
  title,
  actions,
  headerProps,
  children,
}: {
  as?: ElementType;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  wrapped?: boolean;
  title?: ReactNode;
  actions?: ReactNode;
  headerProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <Wrapper
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div
        {...headerProps}
        className={cn(
          "chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none",
          headerProps?.className,
        )}
      >
        {title ?? (
          <span className="min-w-0 truncate font-mono text-2xs">{fenceTitle ?? language}</span>
        )}
        {actions}
      </div>
      {children}
    </Wrapper>
  );
}
