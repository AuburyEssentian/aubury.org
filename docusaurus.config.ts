import * as fs from 'node:fs';
import * as path from 'node:path';
import {themes as prismThemes} from 'prism-react-renderer';
import type {Config, Plugin} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

type HomepageBlogPost = {
  title: string;
  date: string;
  permalink: string;
  description: string;
  tags: string[];
  image?: string;
  readingTime: number;
};

type HomepageBlogData = {
  posts: HomepageBlogPost[];
  postCount: number;
  topTags: string[];
};

type ParsedPost = HomepageBlogPost & {
  sortTime: number;
  source: string;
};

const BLOG_DIR = path.join(process.cwd(), 'blog');
const COMMON_TAGS = new Set(['ethereum', 'data', 'research', 'analysis']);

function cleanYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseYamlValue(value: string): string | string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => cleanYamlScalar(item))
      .filter(Boolean);
  }
  return cleanYamlScalar(trimmed);
}

function parseFrontMatter(markdown: string): {frontMatter: Record<string, string | string[]>; body: string} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {frontMatter: {}, body: markdown};
  }

  const frontMatter: Record<string, string | string[]> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    frontMatter[key] = parseYamlValue(value);
  }

  return {frontMatter, body: markdown.slice(match[0].length)};
}

function scalar(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function arrayValue(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, maxLength = 170): string {
  if (text.length <= maxLength) {
    return text;
  }

  const clipped = text.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return `${clipped}…`;
}

function excerptFromBody(body: string): string {
  const beforeTruncate = body.split('<!-- truncate -->')[0] || body;
  return truncate(stripMarkdown(beforeTruncate));
}

function extractFirstImage(body: string): string | undefined {
  return (
    body.match(/<img\s+[^>]*src=["']([^"']+)["']/i)?.[1] ??
    body.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/)?.[1]
  );
}

function estimateReadingTime(body: string): number {
  const words = stripMarkdown(body).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function fallbackSlug(fileName: string): string {
  return fileName.replace(/\.mdx?$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function permalinkFor(slug: string): string {
  const normalized = slug.replace(/^\/+/, '');
  if (normalized.startsWith('blog/')) {
    return `/${normalized}`;
  }
  return `/blog/${normalized}`;
}

function readPost(fileName: string): ParsedPost | null {
  const absolutePath = path.join(BLOG_DIR, fileName);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const {frontMatter, body} = parseFrontMatter(source);
  const title = scalar(frontMatter.title);

  if (!title) {
    return null;
  }

  const slug = scalar(frontMatter.slug) ?? fallbackSlug(fileName);
  const date = (scalar(frontMatter.date) ?? fileName.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '').slice(0, 10);
  const tags = arrayValue(frontMatter.tags).map((tag) => tag.toLowerCase());

  return {
    title,
    date,
    permalink: permalinkFor(slug),
    description: scalar(frontMatter.description) ?? excerptFromBody(body),
    tags,
    image: extractFirstImage(body),
    readingTime: estimateReadingTime(body),
    sortTime: Date.parse(`${date || '1970-01-01'}T00:00:00Z`),
    source: fileName,
  };
}

function getHomepageBlogData(): HomepageBlogData {
  if (!fs.existsSync(BLOG_DIR)) {
    return {posts: [], postCount: 0, topTags: []};
  }

  const parsedPosts = fs
    .readdirSync(BLOG_DIR)
    .filter((fileName) => /\.mdx?$/.test(fileName))
    .map(readPost)
    .filter((post): post is ParsedPost => Boolean(post))
    .sort((a, b) => b.sortTime - a.sortTime || b.source.localeCompare(a.source));

  const tagCounts = new Map<string, number>();
  for (const post of parsedPosts) {
    for (const tag of post.tags) {
      if (!COMMON_TAGS.has(tag)) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([tag]) => tag);

  const posts = parsedPosts.map(({sortTime, source, ...post}) => post);
  return {posts, postCount: posts.length, topTags};
}

function homepageBlogDataPlugin(): Plugin<HomepageBlogData> {
  return {
    name: 'homepage-blog-data',
    async loadContent() {
      return getHomepageBlogData();
    },
    async contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },
  };
}

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

  clientModules: [
    './src/clientModules/imageZoom.ts',
  ],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: [homepageBlogDataPlugin],

  presets: [
    [
      'classic',
      {
        docs: false,
        blog: {
          routeBasePath: 'blog',
          showReadingTime: true,
          blogSidebarCount: 0, // No sidebar
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
    image: 'img/avatar.png',
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'Aubury Essentian',
      logo: {
        alt: 'Aubury',
        src: 'img/aubury-logo.png',
      },
      items: [
        {to: '/blog', label: 'Blog', position: 'left'},
        {to: '/about', label: 'About', position: 'left'},
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
          title: 'Research',
          items: [
            {label: 'Blog', to: '/blog'},
            {label: 'Archive', to: '/blog/archive'},
            {label: 'Tags', to: '/blog/tags'},
          ],
        },
        {
          title: 'Protocol lanes',
          items: [
            {label: 'Blobs', to: '/blog/tags/blobs'},
            {label: 'Consensus', to: '/blog/tags/consensus'},
            {label: 'MEV', to: '/blog/tags/mev'},
          ],
        },
        {
          title: 'Elsewhere',
          items: [
            {label: 'GitHub', href: 'https://github.com/AuburyEssentian'},
            {label: 'RSS', href: 'https://aubury.org/blog/rss.xml'},
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
