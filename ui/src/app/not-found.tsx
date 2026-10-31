import { Link } from "@tanstack/react-router";
import { CenteredPage } from "@/app/brand";

export function NotFound() {
  return (
    <CenteredPage>
      <div className="card enter p-6">
        <p className="t-crumb">404</p>
        <h1 className="t-title mt-2">Page not found</h1>
        <p className="mt-2 text-sm text-mute">No page has this address.</p>
        <Link to="/" className="link mt-4 inline-block text-sm">
          Go to the start page
        </Link>
      </div>
    </CenteredPage>
  );
}
