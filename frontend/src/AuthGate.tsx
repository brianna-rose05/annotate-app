import type { ReactNode } from "react";
import { useAuth } from "react-oidc-context";
import { signOutUrl } from "./auth";

export default function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  if (auth.isLoading) {
    return <div className="auth-screen"><p className="muted">Loading…</p></div>;
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Annotate</h1>
          <p className="muted">Save articles and PDFs, highlight them, and organize what matters.</p>
          {auth.error && <p className="message message-error">Sign-in failed: {auth.error.message}</p>}
          <button className="btn btn-primary" onClick={() => auth.signinRedirect()}>
            Sign in or create an account
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="account-bar">
        <span className="muted">{auth.user?.profile.email}</span>
        <button
          className="btn btn-small btn-ghost"
          onClick={async () => {
            await auth.removeUser(); // forget the tokens in this browser
            window.location.href = signOutUrl(); // end the session on Cognito too
          }}
        >
          Sign out
        </button>
      </div>
      {children}
    </>
  );
}