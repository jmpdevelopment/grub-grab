import { Component, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { noteError } from '../lib/feedback'

/** Instead of a blank page when part of the app crashes: say so, offer a reload, and report it. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  componentDidCatch(error: unknown) {
    noteError(error, 'crash')
  }

  render() {
    return this.state.crashed ? <Crashed /> : this.props.children
  }
}

function Crashed() {
  const { t } = useI18n()
  return (
    <div className="splash" role="alert">
      <h1>{t('crash.title')}</h1>
      <p className="muted">{t('crash.text')}</p>
      <button className="btn" onClick={() => window.location.reload()}>{t('crash.reload')}</button>
    </div>
  )
}
