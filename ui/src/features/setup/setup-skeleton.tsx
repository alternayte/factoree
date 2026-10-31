import { Frame, navList } from "@/app/shell";
import { Loading, Skeleton, SkeletonCard } from "@/components/layout";
import { SETUP_STEPS } from "./steps";

/** SetupStepsSkeleton has the shape of the setup steps while the status loads. */
export function SetupStepsSkeleton() {
  return (
    <Frame
      narrow
      navLabel="Setup steps"
      nav={
        <div className={navList}>
          {SETUP_STEPS.map((step) => (
            <span key={step.id} className="nav-link">
              <span className="step-marker" />
              <Skeleton className="h-3 w-20" />
            </span>
          ))}
        </div>
      }
    >
      <Loading label="Loading the setup status">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="mt-3 h-5 w-48" />
        <Skeleton className="mt-3 mb-6 h-3 w-full max-w-md" />
      </Loading>
      <SkeletonCard fields={4} />
    </Frame>
  );
}
