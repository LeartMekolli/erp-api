import { Injectable } from '@nestjs/common';
import type { FeedSnapshot } from '../material-price';

/** The latest feed price per metal and currency. Snapshots arrive with the price feed (plan Task 4). */
@Injectable()
export class SnapshotsService {
  latest(_metal: string, _currency: string): Promise<FeedSnapshot | null> {
    return Promise.resolve(null);
  }
}
