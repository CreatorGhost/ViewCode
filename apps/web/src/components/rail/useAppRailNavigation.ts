import { useLocation, useNavigate } from "@tanstack/react-router";

export function useAppSettingsRoute() {
  const navigate = useNavigate();
  const onSettings = useLocation({
    select: (location) =>
      location.pathname === "/settings" || location.pathname.startsWith("/settings/"),
  });
  const openSettings = () => void navigate({ to: "/settings" });
  return { onSettings, openSettings };
}
