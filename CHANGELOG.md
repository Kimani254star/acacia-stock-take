# Acacia Stock Count - changelog

## 1.1.0 - 18 Nov 2026

### Fixed
- Logo and icons did not load (pages pointed to an `icons/` folder that does not exist). This also made the service worker fail to install, so the app never worked offline. Paths now match the real files.
- Quantities of 1,000 or more: the box showed `1,500`, and editing it read it back as 1.5. Boxes now show plain numbers, and `1,500` is read as 1500.
- Pressing Enter on a name search that matched nothing did nothing. It now shows a message.
- Going online/offline while typing a quantity discarded the number. It is now saved first.
- Two items with the same SKU/name in one stock take shared a single count. Each item is now listed once.
- Counts are also saved when the app goes to the background (`visibilitychange`), not only on `pagehide`.
- A failed sign-in cleared the company and email fields.
- Service worker: error responses were cached, and one missing file broke the whole offline install.

### Added
- Download or share counts as CSV (review screen and Reports). Useful as a backup if a push fails.
- "What's new" screen in the menu, and the version number in the menu.
- Show password on sign-in.
- Quantity box selects its content when tapped.
- Different vibration for a scanned code that is not in the list.
- Clear message when the session has expired.
- Accessibility labels on quantity boxes.
- Content-Security-Policy, X-Frame-Options and a no-JS notice.

### Notes
- `acaciabooks-logo.png` (1.3 MB) is not used anywhere. It can be deleted.
- Deploy: replace all files, then open the app once online so the new service worker (`acx-stockcount-v6`) installs.


## 1.2.0 — 18 Nov 2026

- Added Stock Assessments, Variance Management, Recount Management, Approval Centre, Counting Assignments, Stock Reports and Audit Trail navigation.
- Added section / shelf / rack / bin tagging and section filtering during counts.
- Added alternate barcode / QR codes and unknown scanned-code capture.
- Added batch, expiry, serial-number and item-condition capture.
- Added variance quantity, percentage and cost valuation where the synced Books inventory records expose system quantity and unit cost fields.
- Added company-scoped cloud storage for assignment and audit events, with local offline copies.
- Kept the count-entry screen blind; expected stock quantities are not displayed to counters.
- Approval Centre is a local review tracker only; final approval and inventory posting remain in Acacia Books.


## Version 1.3.0
- Expanded Appearance font choices to 60 font types.
- Replaced the font tile grid with a searchable-friendly native dropdown and a live font preview.
- Cambria is the default font; the selected font is saved on the device and restored on next visit.
- Added Google Fonts loading for web fonts and sensible local fallbacks when offline.
