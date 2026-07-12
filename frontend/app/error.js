'use client';

import { useEffect } from 'react';

export default function Error({ error, reset }) {
  useEffect(() => {
    console.error('Centralized Error Boundary caught exception:', error);
  }, [error]);

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#0f172a',
      color: 'white',
      fontFamily: 'sans-serif',
      padding: '20px',
      textAlign: 'center'
    }}>
      <h2 style={{ marginBottom: '16px', fontWeight: '700', fontSize: '24px' }}>StackChat Runtime Failure</h2>
      <p style={{ color: '#94a3b8', marginBottom: '24px', maxWidth: '400px', fontSize: '14px' }}>
        {error.message || 'An unexpected client-side rendering exception occurred.'}
      </p>
      <button
        onClick={() => reset()}
        style={{
          padding: '12px 24px',
          backgroundColor: '#6366f1',
          border: 'none',
          borderRadius: '6px',
          color: 'white',
          fontWeight: '600',
          cursor: 'pointer',
          transition: 'background-color 0.2s ease'
        }}
      >
        Reload Interface
      </button>
    </div>
  );
}
