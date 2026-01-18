// Panel components: canonical top-down imports.
// Importing this module defines the panel-level custom elements.

import '../entries/lazy_media.js';

import './profile/profile.js';
import '../bars/notification_bar.js';
import '../shell/panel_shell.js';

import './posts/my_posts.js';
import './connections/connections.js';
import './notifications/notifications.js';
import './notifications/notifications_panel.js';
import './content/content_panel.js';
import './people/people_panel.js';
import './groups/groups_panel.js';
import './group/group_home.js';
import './thread/thread_tree.js';
import './comment/comment_composer.js';

// Legacy/non-panel utilities & components (still used in some flows).
import './feed/feed.js';
import './follows/followers.js';
import './follows/following.js';
import './system/cache_status.js';
import './system/db_manager.js';
import './system/cache_settings_lightbox.js';

// Nothing to export; modules are imported for side effects.
