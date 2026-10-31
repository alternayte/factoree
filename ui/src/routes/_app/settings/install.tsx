import { createFileRoute } from "@tanstack/react-router";
import { InstallSettingsPage } from "@/features/settings/install-settings-page";

export const Route = createFileRoute("/_app/settings/install")({
  component: InstallSettingsPage,
});
