import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

export function useAppSettingsRoute() {
  const navigate = useNavigate();
  const onSettings = useLocation({
    select: (location) =>
      location.pathname === "/settings" || location.pathname.startsWith("/settings/"),
  });
  const openSettings = useCallback(() => void navigate({ to: "/settings" }), [navigate]);
  return { onSettings, openSettings };
}
