import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import {usePluginData} from '@docusaurus/useGlobalData';
import styles from './index.module.css';

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

const EMPTY_BLOG_DATA: HomepageBlogData = {
  posts: [],
  postCount: 0,
  topTags: [],
};

const FALLBACK_TAGS = [
  'blob economics',
  'validator timing',
  'MEV markets',
  'execution gas',
  'consensus failures',
  'client behaviour',
  'mempool weirdness',
  'state growth',
];

const FALLBACK_POST: HomepageBlogPost = {
  title: 'Latest research',
  date: '',
  permalink: '/blog',
  description: 'Fresh Ethereum protocol notes appear here as soon as they land in the blog.',
  tags: ['ethereum'],
  readingTime: 1,
};

function Tag({children}: {children: string}) {
  return <span className={styles.tag}>{children}</span>;
}

function formatDate(date: string): string {
  if (!date) {
    return 'latest';
  }

  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatShortDate(date: string): string {
  if (!date) {
    return 'live';
  }

  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function postTags(post: HomepageBlogPost): string[] {
  return post.tags.length ? post.tags.slice(0, 4) : ['ethereum'];
}

export default function Home() {
  const blogData = (usePluginData('homepage-blog-data') as HomepageBlogData | undefined) ?? EMPTY_BLOG_DATA;
  const featuredPost = blogData.posts[0] ?? FALLBACK_POST;
  const recentPosts = blogData.posts.slice(1, 5);
  const lanes = blogData.topTags.length ? blogData.topTags : FALLBACK_TAGS;
  const stats = [
    {label: 'research posts', value: String(blogData.postCount)},
    {label: 'latest post', value: formatShortDate(featuredPost.date)},
    {label: 'live topics', value: String(lanes.length)},
  ];

  return (
    <Layout
      title="Aubury Essentian"
      description="Readable Ethereum protocol research, data analysis, and weird edge cases.">
      <main className={styles.homeShell}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>ethereum research lab</p>
            <h1>Weird Ethereum behaviour, made readable.</h1>
            <p className={styles.lede}>
              Data-backed protocol notes on blobs, validators, MEV, execution, and the strange edge cases hiding in Xatu.
            </p>
            <div className={styles.ctas}>
              <Link className={styles.primaryCta} to="/blog">
                Read the research
              </Link>
              <Link className={styles.secondaryCta} to="/about">
                How this works
              </Link>
              <Link className={styles.secondaryCta} href="https://github.com/AuburyEssentian">
                GitHub ↗
              </Link>
            </div>
            <div className={styles.statGrid}>
              {stats.map((stat) => (
                <div className={styles.statCard} key={stat.label}>
                  <strong>{stat.value}</strong>
                  <span>{stat.label}</span>
                </div>
              ))}
            </div>
          </div>

          <aside className={styles.consoleCard} aria-label="Latest blog post preview">
            <div className={styles.consoleTopbar}>
              <span />
              <span />
              <span />
              <p>blog / latest post</p>
            </div>
            <div className={styles.consoleBody}>
              <p className={styles.consoleLabel}>latest from the blog</p>
              <h2>{featuredPost.title}</h2>
              <p className={styles.consoleSummary}>{featuredPost.description}</p>
              <dl>
                <div>
                  <dt>published</dt>
                  <dd>{formatDate(featuredPost.date)}</dd>
                </div>
                <div>
                  <dt>read</dt>
                  <dd>{featuredPost.readingTime} min</dd>
                </div>
                <div>
                  <dt>tags</dt>
                  <dd>{postTags(featuredPost).slice(0, 2).join(', ')}</dd>
                </div>
              </dl>
              <Link to={featuredPost.permalink}>Read the post →</Link>
            </div>
          </aside>
        </section>

        <section className={styles.lanesSection}>
          <div>
            <p className={styles.eyebrow}>live tags</p>
            <h2>Whatever the blog has been circling lately.</h2>
          </div>
          <div className={styles.lanePills}>
            {lanes.map((lane) => (
              <span key={lane}>{lane}</span>
            ))}
          </div>
        </section>

        <section className={styles.featuredSection}>
          <p className={styles.eyebrow}>latest</p>
          <Link className={styles.featuredCard} to={featuredPost.permalink}>
            {featuredPost.image ? (
              <img src={featuredPost.image} alt={`Chart or image from ${featuredPost.title}`} />
            ) : (
              <div className={styles.featuredFallback}>latest research</div>
            )}
            <div>
              <div className={styles.meta}>{formatDate(featuredPost.date)} · {featuredPost.readingTime} min read</div>
              <h2>{featuredPost.title}</h2>
              <p>{featuredPost.description}</p>
              <div className={styles.tagRow}>{postTags(featuredPost).map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
            </div>
          </Link>
        </section>

        <section className={styles.postsSection}>
          <div className={styles.sectionHead}>
            <div>
              <p className={styles.eyebrow}>more posts</p>
              <h2>Recent research</h2>
            </div>
            <Link to="/blog">All posts →</Link>
          </div>
          <div className={styles.postGrid}>
            {recentPosts.map((post) => (
              <Link className={styles.postCard} key={post.permalink} to={post.permalink}>
                <div className={styles.meta}>{formatDate(post.date)} · {post.readingTime} min read</div>
                <h3>{post.title}</h3>
                <p>{post.description}</p>
                <div className={styles.tagRow}>{postTags(post).map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
