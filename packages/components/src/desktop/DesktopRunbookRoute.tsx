import type { ComponentProps } from 'react'
import { DragDropProvider } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import DesktopRunbookPage from './DesktopRunbookPage'
import type { SortableItemProps } from './runbook/RunbookActionList'
import { ipcInvoke } from './DesktopIpcRuntime'
import { captureDesktopAnalyticsEvent } from './DesktopPosthogRenderer'

// Module level, so React Compiler sees the same static hook on every render.
function DesktopSortableItem({ children, ...options }: SortableItemProps) {
  const { ref, isDragging, isDragSource, isDropTarget } = useSortable(options)
  return children({ ref, isDragging, isDragSource, isDropTarget })
}

const dragDropRuntime = {
  DragDropProvider,
  isSortable: isSortable as ComponentProps<
    typeof DesktopRunbookPage
  >['dragDropRuntime']['isSortable'],
  SortableItem: DesktopSortableItem,
} satisfies ComponentProps<typeof DesktopRunbookPage>['dragDropRuntime']

export default function DesktopRunbookRoute() {
  return (
    <DesktopRunbookPage
      ipcInvoke={ipcInvoke}
      captureDesktopAnalyticsEvent={captureDesktopAnalyticsEvent}
      dragDropRuntime={dragDropRuntime}
    />
  )
}
