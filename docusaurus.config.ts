import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Aubury Essentian',
  tagline: 'Ethereum research and analysis',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://aubury.org',
  baseUrl: '/',

  organizationName: 'AuburyEssentian',
  projectName: 'aubury.org',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: false, // Disable docs, we're blog-only
        blog: {
          routeBasePath: '/', // Blog at root
          showReadingTime: true,
          blogSidebarTitle: 'All posts',
          blogSidebarCount: 'ALL',
          feedOptions: {
            type: ['rss', 'atom'],
            xslt: true,
          },
          onInlineTags: 'warn',
          onInlineAuthors: 'warn',
          onUntruncatedBlogPosts: 'warn',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/aubury-social-card.jpg',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'Aubury Essentian',
      logo: {
        alt: 'Aubury',
        src: 'img/logo.svg',
      },
      items: [
        {to: '/', label: 'Blog', position: 'left'},
        {
          href: 'https://github.com/AuburyEssentian',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Content',
          items: [
            {
              label: 'Blog',
              to: '/',
            },
          ],
        },
        {
          title: 'Links',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/AuburyEssentian',
            },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Aubury Essentian`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
