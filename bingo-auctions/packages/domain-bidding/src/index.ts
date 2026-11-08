// Components
export { LotCard, CARD_WIDTH } from './components/LotCard';
export type { LotCardData, LotCardSource } from './components/LotCard';
export { PlaceBidSheet } from './components/PlaceBidSheet';
export type { PlaceBidSheetProps } from './components/PlaceBidSheet';
export { BuyNowSheet } from './components/BuyNowSheet';
export type { BuyNowSheetProps } from './components/BuyNowSheet';
export { LiveBidTicker } from './components/LiveBidTicker';
export { PhotoCarousel } from './components/PhotoCarousel';
export { PhotoLightbox } from './components/PhotoLightbox';
export { WatchlistToggle } from './components/WatchlistToggle';
export { RecentWinsRail } from './components/RecentWinsRail';
export type { RecentWin } from './components/RecentWinsRail';

// Hooks
export { useCategories } from './hooks/useCategories';
export type { CategoryRow, CategoryView } from './hooks/useCategories';

// Stores (AsyncStorage-backed)
export {
  addRecentlyViewed,
  getRecentlyViewed,
  clearRecentlyViewed,
} from './stores/recentlyViewed';
export {
  createSavedSearch,
  listSavedSearches,
  deleteSavedSearch,
  updateSavedSearchNotify,
  defaultNameFromCriteria,
  summarizeCriteria,
} from './stores/savedSearches';
export type { SavedSearch, SavedSearchCriteria } from './stores/savedSearches';
