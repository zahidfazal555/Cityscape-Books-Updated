import { Suspense } from 'react';
import { ResumeSession } from './resume';

export default function SessionPage() {
  return (
    <Suspense>
      <ResumeSession />
    </Suspense>
  );
}
