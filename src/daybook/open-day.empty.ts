import { Paged } from '../common/interceptors/response.interceptor';

// What restricted reads answer a non-admin when no business day is open.
export const noRows = () => [];
export const noPage = () => new Paged([], { page: 1, limit: 200, total: 0 });
export const noValue = () => null;
