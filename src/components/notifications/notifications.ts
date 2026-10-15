import { createContext, useContext } from 'react'

export type NotificationTone = 'success' | 'info' | 'warning' | 'error'
export type NotificationInput = {
  title: string
  message?: string
  /** Notifications with the same key replace each other instead of stacking. */
  key?: string
  /** Milliseconds until the notification closes; errors stay until closed unless set. */
  duration?: number
}
export type Notify = Record<NotificationTone, (title: string, options?: Omit<NotificationInput, 'title'>) => void>

export const NotificationContext = createContext<Notify | null>(null)

/**
 * App-wide feedback for the outcome of an action (saved, deleted, imported, failed).
 * Inline messages stay reserved for form validation and persistent page states.
 */
export function useNotify() {
  const notify = useContext(NotificationContext)
  if (!notify) throw new Error('useNotify must be used inside NotificationProvider.')
  return notify
}
