import type { ReactNode } from "react";
import { useAuth } from "react-oidc-context";
import { signOutUrl } from "./auth";

const DEMO_EMAIL = "brianna.pischke+demo@gmail.com";
const DEMO_PASSWORD = "<PASTE DEMO PASSWORD HERE>";
const demoPasswordSet = !DEMO_PASSWORD.startsWith("<"); // the hint stays hidden until it's filled in

export default function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  async function signOut() {
    await auth.removeUser(); // forget the tokens in this browser
    window.location.href = signOutUrl(); // end the session on Cognito too
  }

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
          {demoPasswordSet && (
            <p className="muted auth-demo">
              Just looking? Try the demo — email: {DEMO_EMAIL}, password: {DEMO_PASSWORD}
            </p>
          )}
        </div>
      </div>
    );
  }

  const isDemo = auth.user?.profile.email?.toLowerCase() === DEMO_EMAIL;

  return (
    <>
      {isDemo && (
        <div className="demo-banner">
          You're viewing a read-only demo. Sign up to save your own articles.{" "}
          <button className="link-btn" onClick={signOut}>
            Sign up
          </button>
        </div>
      )}
      <div className="account-bar">
        <span className="muted">{auth.user?.profile.email}</span>
        <button
          className="btn btn-small btn-ghost"
          onClick={signOut}
        >
          Sign out
        </button>
      </div>
      {children}
    </>
  );
}