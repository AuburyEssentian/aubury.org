import mediumZoom from 'medium-zoom';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

export function onRouteDidUpdate() {
  if (ExecutionEnvironment.canUseDOM) {
    mediumZoom('.markdown img:not(.no-zoom)', {
      background: 'rgba(0, 0, 0, 0.85)',
      margin: 24,
    });
  }
}
