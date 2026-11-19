const paths = {
  chats:
    'M13.8 7.8a5.8 5.8 0 0 1-5.9 5.7 6.4 6.4 0 0 1-2.6-.6l-3.2.8.8-3.1a5.4 5.4 0 0 1-.8-2.8 5.9 5.9 0 0 1 11.7 0Z',
  select: 'M5 4h8M5 8h8M5 12h8M2 4h.1M2 8h.1M2 12h.1',
  folder: 'M2 5a1 1 0 0 1 1-1h4l1.5 2h4.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z',
  favorite: 'M4 2.5h8v11l-4-2.7-4 2.7Z',
  memory: 'M3 2.5h10v11H4.5A1.5 1.5 0 0 1 3 12Zm0 8h10M6 5.5h4',
  pin: 'm6 2.5 6 2-2.3 2.2-.5 2.1.7 2.2-6.6-2.2 1.8-1.2 1-2.1Zm.6 7-1.4 4',
}
export const LibraryIcon = ({ name }: { name: keyof typeof paths }) => (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.45"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={paths[name]} />
  </svg>
)
