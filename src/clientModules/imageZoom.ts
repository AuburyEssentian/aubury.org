import mediumZoom from 'medium-zoom';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

let zoom: ReturnType<typeof mediumZoom> | null = null;

const imageSelector = '.markdown img:not(.no-zoom)';
const mobileMediaQuery = '(max-width: 720px)';

export function onRouteDidUpdate() {
  if (!ExecutionEnvironment.canUseDOM) {
    return;
  }

  const images = Array.from(document.querySelectorAll<HTMLImageElement>(imageSelector));

  zoom?.detach();
  zoom = null;

  images.forEach((image) => {
    image.onclick = null;
    image.removeAttribute('title');
  });

  if (window.matchMedia(mobileMediaQuery).matches) {
    images.forEach((image) => {
      image.title = 'Open chart full size';
      image.onclick = (event) => {
        event.preventDefault();
        window.open(image.currentSrc || image.src, '_blank', 'noopener,noreferrer');
      };
    });
    return;
  }

  zoom = mediumZoom(images, {
    background: 'rgba(0, 0, 0, 0.85)',
    margin: 48,
  });
}
