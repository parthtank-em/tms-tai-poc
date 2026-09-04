import { redirect } from "next/navigation";

/**
 * The console has one entry point. Unauthenticated visitors bounce on to
 * /login from here via src/proxy.ts, carrying /shipments as the return path.
 */
export default function Home() {
  redirect("/shipments");
}
