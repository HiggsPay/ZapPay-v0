// Auth is handled entirely by Clerk.
// This file re-exports Clerk hooks under the same names used throughout the app
// so other components need no changes.
export { useAuth, useUser, useClerk } from "@clerk/clerk-react";
