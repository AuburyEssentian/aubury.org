import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

const FEATURED_POST = {
  title: "Ethereum's June blob surge was 6x bigger than my chart said",
  date: '2026-06-19',
  slug: '/blog/blob-surge-six-times-bigger',
  image: '/img/blob-surge-six-times-bigger.png',
  summary:
    'I divided blob gas by a six-blob denominator and accidentally counted six-blob bundles as blobs. June 3 was 38,445 blobs, not 6,408.',
  tags: ['blobs', 'rollups', 'correction'],
};

const RECENT_POSTS = [
  {
    title: 'The June Blob Surge',
    date: '2026-06-13',
    slug: '/blog/rollup-blob-surge',
    summary:
      'Rollup blob demand moved hard in early June. The original chart was undercounted, but the shape was real.',
    tags: ['blobs', 'rollups'],
  },
  {
    title: "ETH is inflationary now, and the burn rate won't save it",
    date: '2026-03-08',
    slug: '/blog/eth-burn-post-fulu',
    summary:
      'The post-Merge supply story changed once blob fees pulled activity away from the EIP-1559 burn.',
    tags: ['issuance', 'fees'],
  },
  {
    title: 'Ethereum Lost Finality for Three Hours on March 2',
    date: '2026-03-07',
    slug: '/blog/ethereum-march2-finality-loss',
    summary:
      'Block orphan rates hit 68%, participation collapsed, and the chain stopped finalizing for close to three hours.',
    tags: ['consensus', 'incidents'],
  },
  {
    title: 'The Blob Propagation Tax',
    date: '2026-03-07',
    slug: '/blog/blob-propagation-tax',
    summary:
      'Every blob makes it a little harder for validators to attest on time. The cost shows up in rewards.',
    tags: ['blobs', 'attestations'],
  },
];

const STATS = [
  {label: 'research posts', value: '53'},
  {label: 'public repos', value: '3'},
  {label: 'aubury.org', value: 'live'},
];

const LANES = [
  'blob economics',
  'validator timing',
  'MEV markets',
  'execution gas',
  'consensus failures',
  'client behaviour',
  'mempool weirdness',
  'state growth',
];

function Tag({children}: {children: string}) {
  return <span className={styles.tag}>{children}</span>;
}

export default function Home() {
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
              {STATS.map((stat) => (
                <div className={styles.statCard} key={stat.label}>
                  <strong>{stat.value}</strong>
                  <span>{stat.label}</span>
                </div>
              ))}
            </div>
          </div>

          <aside className={styles.consoleCard} aria-label="Research console preview">
            <div className={styles.consoleTopbar}>
              <span />
              <span />
              <span />
              <p>xatu / latest finding</p>
            </div>
            <div className={styles.consoleBody}>
              <p className={styles.consoleLabel}>latest correction</p>
              <h2>June blob demand was 6x undercounted</h2>
              <dl>
                <div>
                  <dt>June 3</dt>
                  <dd>38,445 blobs</dd>
                </div>
                <div>
                  <dt>June 18 high</dt>
                  <dd>40,822 blobs</dd>
                </div>
                <div>
                  <dt>peak hour</dt>
                  <dd>2,971 blobs</dd>
                </div>
              </dl>
              <Link to={FEATURED_POST.slug}>Read the post →</Link>
            </div>
          </aside>
        </section>

        <section className={styles.lanesSection}>
          <div>
            <p className={styles.eyebrow}>research lanes</p>
            <h2>Protocol questions that need numbers, not vibes.</h2>
          </div>
          <div className={styles.lanePills}>
            {LANES.map((lane) => (
              <span key={lane}>{lane}</span>
            ))}
          </div>
        </section>

        <section className={styles.featuredSection}>
          <p className={styles.eyebrow}>latest</p>
          <Link className={styles.featuredCard} to={FEATURED_POST.slug}>
            <img src={FEATURED_POST.image} alt="Chart from the latest Ethereum blob count correction" />
            <div>
              <div className={styles.meta}>{FEATURED_POST.date} · 3 min read</div>
              <h2>{FEATURED_POST.title}</h2>
              <p>{FEATURED_POST.summary}</p>
              <div className={styles.tagRow}>{FEATURED_POST.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
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
            {RECENT_POSTS.map((post) => (
              <Link className={styles.postCard} key={post.slug} to={post.slug}>
                <div className={styles.meta}>{post.date}</div>
                <h3>{post.title}</h3>
                <p>{post.summary}</p>
                <div className={styles.tagRow}>{post.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
