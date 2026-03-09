import { authClient } from "@/lib/auth-client";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import "@/lib/api";
import { postApiV1SharedSlackClaim } from "../../lib/api/sdk.gen";

export function SlackClaimPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: session, isPending } = authClient.useSession();
  const submittedRef = useRef(false);

  const claimPayload = useMemo(() => {
    const teamId = searchParams.get("teamId") ?? "";
    const teamName = searchParams.get("teamName") ?? undefined;
    const slackUserId = searchParams.get("slackUserId") ?? "";
    if (!teamId || !slackUserId) {
      return null;
    }
    return {
      teamId,
      teamName,
      slackUserId,
    };
  }, [searchParams]);

  const claimMutation = useMutation({
    mutationFn: async () => {
      if (!claimPayload) {
        throw new Error("Missing claim parameters");
      }
      const { data, error } = await postApiV1SharedSlackClaim({
        body: claimPayload,
      });
      if (error) {
        const message =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
            ? error.message
            : "Claim failed";
        throw new Error(message);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Slack account claimed");
      navigate("/onboarding?orgAuthorized=true", { replace: true });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  useEffect(() => {
    if (!session?.user || !claimPayload || submittedRef.current) {
      return;
    }
    submittedRef.current = true;
    claimMutation.mutate();
  }, [session?.user, claimPayload, claimMutation]);

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-text-muted" />
      </div>
    );
  }

  if (!claimPayload) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6 text-center">
          <h1 className="text-lg font-semibold text-text-primary">
            Invalid claim link
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            Missing required Slack claim parameters.
          </p>
          <Link
            to="/auth"
            className="mt-5 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (!session?.user) {
    const returnTo = encodeURIComponent(
      `/claim?${new URLSearchParams(searchParams).toString()}`,
    );
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6 text-center">
          <h1 className="text-lg font-semibold text-text-primary">
            Continue to claim Slack access
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            Sign in first to link this Slack identity to your Nexu account.
          </p>
          <Link
            to={`/auth?source=slack_shared_claim&returnTo=${returnTo}`}
            className="mt-5 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
          >
            Continue
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6 text-center">
        {claimMutation.isPending ? (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-text-muted" />
            <h1 className="mt-4 text-lg font-semibold text-text-primary">
              Claiming your Slack access...
            </h1>
          </>
        ) : (
          <>
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
            <h1 className="mt-4 text-lg font-semibold text-text-primary">
              Slack access claimed
            </h1>
          </>
        )}
      </div>
    </div>
  );
}
