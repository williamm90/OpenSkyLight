import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { PairScreen } from './features/shell/PairScreen'
import { fetchPairedStatus, installWebBridge, isWebMode } from './api/webBridge'
import './styles/global.css'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
})

const root = ReactDOM.createRoot(document.getElementById('root')!)

function renderApp(): void {
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>
  )
}

async function boot(): Promise<void> {
  // Inside Electron the preload bridge already provides window.osl.
  if (!isWebMode()) {
    renderApp()
    return
  }
  installWebBridge()
  const paired = await fetchPairedStatus()
  if (paired === true) {
    renderApp()
    return
  }
  root.render(<PairScreen offline={paired === 'offline'} />)
  // a wall screen must recover on its own once the server comes back
  if (paired === 'offline') window.setTimeout(() => window.location.reload(), 10_000)
}

void boot()
