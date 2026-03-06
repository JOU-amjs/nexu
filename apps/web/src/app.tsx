import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthLayout } from "./layouts/auth-layout";
import { InviteGuardLayout } from "./layouts/invite-guard-layout";
import { WorkspaceLayout } from "./layouts/workspace-layout";
import { AuthPage } from "./pages/auth";
import { ChannelsPage } from "./pages/channels";
import { OnboardingPage } from "./pages/onboarding";
import { SessionsPage } from "./pages/sessions";
import { SlackOAuthCallbackPage } from "./pages/slack-oauth-callback";

function DocumentTitleSync() {
  const location = useLocation();

  useEffect(() => {
    const titleByPathname: Record<string, string> = {
      "/auth": "Sign In · Nexu",
      "/onboarding": "Get Started · Nexu",
      "/workspace": "Workspace · Nexu",
    };

    document.title = titleByPathname[location.pathname] ?? "Nexu";
  }, [location.pathname]);

  return null;
}

export function App() {
  return (
    <>
      <DocumentTitleSync />
      <Routes>
        <Route path="/" element={<Navigate to="/workspace" replace />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route element={<AuthLayout />}>
          <Route element={<InviteGuardLayout />}>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route element={<WorkspaceLayout />}>
              <Route path="/workspace" element={<SessionsPage />} />
              <Route path="/workspace/sessions" element={<SessionsPage />} />
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
              <Route path="/workspace/channels" element={<ChannelsPage />} />
              <Route
                path="/workspace/channels/slack/callback"
                element={<SlackOAuthCallbackPage />}
              />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
