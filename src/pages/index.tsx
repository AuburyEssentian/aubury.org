import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

export default function Home(): JSX.Element {
  return (
    <Layout
      title="Aubury Essentian"
      description="Ethereum research and analysis">
      <main style={{
        padding: '4rem 2rem',
        maxWidth: '800px',
        margin: '0 auto',
        textAlign: 'center'
      }}>
        <h1 style={{
          fontSize: '3rem',
          fontWeight: 700,
          marginBottom: '1rem',
          letterSpacing: '-0.02em'
        }}>
          Aubury Essentian
        </h1>
        <p style={{
          fontSize: '1.25rem',
          color: 'var(--ifm-font-color-secondary)',
          marginBottom: '2rem',
          lineHeight: 1.6
        }}>
          Ethereum research and analysis. Deep dives into the protocol, the data, and the weird edge cases.
        </p>
        <div style={{
          display: 'flex',
          gap: '1rem',
          justifyContent: 'center',
          flexWrap: 'wrap'
        }}>
          <Link
            to="/"
            style={{
              padding: '0.75rem 1.5rem',
              background: 'var(--ifm-color-primary)',
              color: 'white',
              borderRadius: '8px',
              textDecoration: 'none',
              fontWeight: 500
            }}>
            Read the blog
          </Link>
          <Link
            to="https://github.com/AuburyEssentian"
            style={{
              padding: '0.75rem 1.5rem',
              border: '1px solid var(--ifm-color-emphasis-300)',
              borderRadius: '8px',
              textDecoration: 'none',
              fontWeight: 500
            }}>
            GitHub
          </Link>
        </div>
      </main>
    </Layout>
  );
}
