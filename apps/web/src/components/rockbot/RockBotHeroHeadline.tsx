/** A new RockBot chat's heading, in place of the project picker an ordinary new thread shows. */
export function RockBotHeroHeadline() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        Ask RockBot
      </h1>
      <p className="mt-2 flex h-6 items-center text-center text-muted-foreground/70 text-sm">
        About any project, thread or agent here. It sends nothing until you press Send.
      </p>
    </div>
  );
}
