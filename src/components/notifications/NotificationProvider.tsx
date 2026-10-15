import { useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { NotificationContext, type Notify, type NotificationInput, type NotificationTone } from './notifications'
import './Notifications.css'

type Notification = Omit<NotificationInput, 'duration'> & { id: number; tone: NotificationTone; duration: number | null }

const defaultDuration: Record<NotificationTone, number | null> = { success: 4500, info: 6000, warning: 8000, error: null }
const icons = { success: CircleCheck, info: Info, warning: TriangleAlert, error: CircleAlert }
const maxVisible = 4
let nextId = 0

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const dismiss = (id: number) => setNotifications((current) => current.filter((entry) => entry.id !== id))

  const notify = useMemo<Notify>(() => {
    const show = (tone: NotificationTone) => (title: string, options: Omit<NotificationInput, 'title'> = {}) => {
      const notification: Notification = { ...options, title, tone, id: ++nextId, duration: options.duration ?? defaultDuration[tone] }
      setNotifications((current) => [...current.filter((entry) => !options.key || entry.key !== options.key), notification].slice(-maxVisible))
    }
    return { success: show('success'), info: show('info'), warning: show('warning'), error: show('error') }
  }, [])

  return <NotificationContext.Provider value={notify}>
    {children}
    <section className="notifications" aria-label="Benachrichtigungen">
      {notifications.map((notification) => {
        const Icon = icons[notification.tone]
        return <div key={notification.id} className={`notification ${notification.tone}`} role={notification.tone === 'error' ? 'alert' : 'status'} aria-live={notification.tone === 'error' ? 'assertive' : 'polite'}>
          <Icon className="notification-icon" size={18} aria-hidden="true" />
          <div className="notification-text">
            <strong>{notification.title}</strong>
            {notification.message && <span>{notification.message}</span>}
          </div>
          <button className="notification-close" aria-label="Benachrichtigung schliessen" title="Schliessen" onClick={() => dismiss(notification.id)}><X size={15} /></button>
          {/* The countdown is a CSS animation: hovering or focusing pauses it, its end closes the notification. */}
          {notification.duration !== null && <span className="notification-timer" style={{ animationDuration: `${notification.duration}ms` }} onAnimationEnd={() => dismiss(notification.id)} />}
        </div>
      })}
    </section>
  </NotificationContext.Provider>
}
