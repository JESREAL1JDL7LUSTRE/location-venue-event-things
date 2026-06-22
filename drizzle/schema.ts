import { pgTable, bigint, varchar, timestamp, unique, integer, index, foreignKey, boolean, check, text, smallint, uniqueIndex, doublePrecision, jsonb } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const djangoMigrations = pgTable("django_migrations", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "django_migrations_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	app: varchar({ length: 255 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	applied: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
});

export const djangoContentType = pgTable("django_content_type", {
	id: integer().primaryKey().generatedByDefaultAsIdentity({ name: "django_content_type_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	appLabel: varchar("app_label", { length: 100 }).notNull(),
	model: varchar({ length: 100 }).notNull(),
}, (table) => [
	unique("django_content_type_app_label_model_76bd3d3b_uniq").on(table.model, table.appLabel),
]);

export const authPermission = pgTable("auth_permission", {
	id: integer().primaryKey().generatedByDefaultAsIdentity({ name: "auth_permission_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	name: varchar({ length: 255 }).notNull(),
	contentTypeId: integer("content_type_id").notNull(),
	codename: varchar({ length: 100 }).notNull(),
}, (table) => [
	index("auth_permission_content_type_id_2f476e4b").using("btree", table.contentTypeId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.contentTypeId],
			foreignColumns: [djangoContentType.id],
			name: "auth_permission_content_type_id_2f476e4b_fk_django_co"
		}),
	unique("auth_permission_content_type_id_codename_01ab375a_uniq").on(table.contentTypeId, table.codename),
]);

export const authGroup = pgTable("auth_group", {
	id: integer().primaryKey().generatedByDefaultAsIdentity({ name: "auth_group_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	name: varchar({ length: 150 }).notNull(),
}, (table) => [
	index("auth_group_name_a6ea08ec_like").using("btree", table.name.asc().nullsLast().op("varchar_pattern_ops")),
	unique("auth_group_name_key").on(table.name),
]);

export const authGroupPermissions = pgTable("auth_group_permissions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "auth_group_permissions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	groupId: integer("group_id").notNull(),
	permissionId: integer("permission_id").notNull(),
}, (table) => [
	index("auth_group_permissions_group_id_b120cbf9").using("btree", table.groupId.asc().nullsLast().op("int4_ops")),
	index("auth_group_permissions_permission_id_84c5c92e").using("btree", table.permissionId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [authGroup.id],
			name: "auth_group_permissions_group_id_b120cbf9_fk_auth_group_id"
		}),
	foreignKey({
			columns: [table.permissionId],
			foreignColumns: [authPermission.id],
			name: "auth_group_permissio_permission_id_84c5c92e_fk_auth_perm"
		}),
	unique("auth_group_permissions_group_id_permission_id_0cd325b0_uniq").on(table.permissionId, table.groupId),
]);

export const authUser = pgTable("auth_user", {
	id: integer().primaryKey().generatedByDefaultAsIdentity({ name: "auth_user_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	password: varchar({ length: 128 }).notNull(),
	lastLogin: timestamp("last_login", { withTimezone: true, mode: 'string' }),
	isSuperuser: boolean("is_superuser").notNull(),
	username: varchar({ length: 150 }).notNull(),
	firstName: varchar("first_name", { length: 150 }).notNull(),
	lastName: varchar("last_name", { length: 150 }).notNull(),
	email: varchar({ length: 254 }).notNull(),
	isStaff: boolean("is_staff").notNull(),
	isActive: boolean("is_active").notNull(),
	dateJoined: timestamp("date_joined", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("auth_user_username_6821ab7c_like").using("btree", table.username.asc().nullsLast().op("varchar_pattern_ops")),
	unique("auth_user_username_key").on(table.username),
]);

export const authUserGroups = pgTable("auth_user_groups", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "auth_user_groups_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	userId: integer("user_id").notNull(),
	groupId: integer("group_id").notNull(),
}, (table) => [
	index("auth_user_groups_group_id_97559544").using("btree", table.groupId.asc().nullsLast().op("int4_ops")),
	index("auth_user_groups_user_id_6a12ed8b").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [authUser.id],
			name: "auth_user_groups_user_id_6a12ed8b_fk_auth_user_id"
		}),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [authGroup.id],
			name: "auth_user_groups_group_id_97559544_fk_auth_group_id"
		}),
	unique("auth_user_groups_user_id_group_id_94350c0c_uniq").on(table.userId, table.groupId),
]);

export const authUserUserPermissions = pgTable("auth_user_user_permissions", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "auth_user_user_permissions_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	userId: integer("user_id").notNull(),
	permissionId: integer("permission_id").notNull(),
}, (table) => [
	index("auth_user_user_permissions_permission_id_1fbb5f2c").using("btree", table.permissionId.asc().nullsLast().op("int4_ops")),
	index("auth_user_user_permissions_user_id_a95ead1b").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [authUser.id],
			name: "auth_user_user_permissions_user_id_a95ead1b_fk_auth_user_id"
		}),
	foreignKey({
			columns: [table.permissionId],
			foreignColumns: [authPermission.id],
			name: "auth_user_user_permi_permission_id_1fbb5f2c_fk_auth_perm"
		}),
	unique("auth_user_user_permissions_user_id_permission_id_14a6b632_uniq").on(table.userId, table.permissionId),
]);

export const djangoAdminLog = pgTable("django_admin_log", {
	id: integer().primaryKey().generatedByDefaultAsIdentity({ name: "django_admin_log_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	actionTime: timestamp("action_time", { withTimezone: true, mode: 'string' }).notNull(),
	objectId: text("object_id"),
	objectRepr: varchar("object_repr", { length: 200 }).notNull(),
	actionFlag: smallint("action_flag").notNull(),
	changeMessage: text("change_message").notNull(),
	contentTypeId: integer("content_type_id"),
	userId: integer("user_id").notNull(),
}, (table) => [
	index("django_admin_log_content_type_id_c4bce8eb").using("btree", table.contentTypeId.asc().nullsLast().op("int4_ops")),
	index("django_admin_log_user_id_c564eba6").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.contentTypeId],
			foreignColumns: [djangoContentType.id],
			name: "django_admin_log_content_type_id_c4bce8eb_fk_django_co"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [authUser.id],
			name: "django_admin_log_user_id_c564eba6_fk_auth_user_id"
		}),
	check("django_admin_log_action_flag_check", sql`action_flag >= 0`),
]);

export const eventsVenue = pgTable("events_venue", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "events_venue_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	name: varchar({ length: 255 }).notNull(),
	slug: varchar({ length: 255 }).notNull(),
	address: varchar({ length: 500 }).notNull(),
	city: varchar({ length: 120 }).notNull(),
	country: varchar({ length: 120 }).notNull(),
	website: varchar({ length: 2000 }).notNull(),
	latitude: doublePrecision(),
	longitude: doublePrecision(),
	source: varchar({ length: 120 }).notNull(),
	sourceUrl: varchar("source_url", { length: 2000 }).notNull(),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	placeId: varchar("place_id", { length: 255 }).notNull(),
	about: text().notNull(),
	amenities: jsonb().notNull(),
	priceLevel: varchar("price_level", { length: 40 }).notNull(),
	primaryType: varchar("primary_type", { length: 120 }).notNull(),
	primaryTypeDisplay: varchar("primary_type_display", { length: 120 }).notNull(),
	rating: doublePrecision(),
	types: jsonb().notNull(),
	verificationStatus: varchar("verification_status", { length: 20 }).default('').notNull(),
	agentsPrimaryTypes: jsonb("agents_primary_types").notNull(),
}, (table) => [
	index("events_venue_place_id_9ea721b9").using("btree", table.placeId.asc().nullsLast().op("text_ops")),
	index("events_venue_place_id_9ea721b9_like").using("btree", table.placeId.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_venue_primary_type_display_ed5f46f6").using("btree", table.primaryTypeDisplay.asc().nullsLast().op("text_ops")),
	index("events_venue_primary_type_display_ed5f46f6_like").using("btree", table.primaryTypeDisplay.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_venue_slug_a9f7b8c8_like").using("btree", table.slug.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_venue_verification_status_cd9fff7e").using("btree", table.verificationStatus.asc().nullsLast().op("text_ops")),
	index("events_venue_verification_status_cd9fff7e_like").using("btree", table.verificationStatus.asc().nullsLast().op("varchar_pattern_ops")),
	uniqueIndex("unique_venue_source_place_id").using("btree", table.source.asc().nullsLast().op("text_ops"), table.placeId.asc().nullsLast().op("text_ops")).where(sql`((place_id)::text > ''::text)`),
	unique("events_venue_slug_key").on(table.slug),
]);

export const djangoSession = pgTable("django_session", {
	sessionKey: varchar("session_key", { length: 40 }).primaryKey().notNull(),
	sessionData: text("session_data").notNull(),
	expireDate: timestamp("expire_date", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("django_session_expire_date_a5c62663").using("btree", table.expireDate.asc().nullsLast().op("timestamptz_ops")),
	index("django_session_session_key_c0390e0f_like").using("btree", table.sessionKey.asc().nullsLast().op("varchar_pattern_ops")),
]);

export const eventsEvent = pgTable("events_event", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "events_event_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	name: varchar({ length: 300 }).notNull(),
	slug: varchar({ length: 300 }).notNull(),
	description: text().notNull(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }),
	url: varchar({ length: 2000 }).notNull(),
	imageUrl: varchar("image_url", { length: 2000 }).notNull(),
	price: varchar({ length: 120 }).notNull(),
	category: varchar({ length: 120 }).notNull(),
	source: varchar({ length: 120 }).notNull(),
	sourceUrl: varchar("source_url", { length: 2000 }).notNull(),
	externalId: varchar("external_id", { length: 255 }).notNull(),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	venueId: bigint("venue_id", { mode: "number" }),
	organizer: varchar({ length: 255 }).notNull(),
	organizerUrl: varchar("organizer_url", { length: 2000 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organizerRefId: bigint("organizer_ref_id", { mode: "number" }),
	agentCategories: jsonb("agent_categories").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	searchQueryId: bigint("search_query_id", { mode: "number" }),
	registrationUrl: varchar("registration_url", { length: 2000 }).notNull(),
}, (table) => [
	index("events_event_external_id_3614f13d").using("btree", table.externalId.asc().nullsLast().op("text_ops")),
	index("events_event_external_id_3614f13d_like").using("btree", table.externalId.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_event_organizer_ref_id_6162f247").using("btree", table.organizerRefId.asc().nullsLast().op("int8_ops")),
	index("events_event_search_query_id_32555112").using("btree", table.searchQueryId.asc().nullsLast().op("int8_ops")),
	index("events_event_slug_b44b2c04_like").using("btree", table.slug.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_event_venue_id_ffde28fd").using("btree", table.venueId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("unique_source_external_id").using("btree", table.source.asc().nullsLast().op("text_ops"), table.externalId.asc().nullsLast().op("text_ops")).where(sql`((external_id)::text > ''::text)`),
	foreignKey({
			columns: [table.venueId],
			foreignColumns: [eventsVenue.id],
			name: "events_event_venue_id_ffde28fd_fk_events_venue_id"
		}),
	foreignKey({
			columns: [table.organizerRefId],
			foreignColumns: [eventsOrganizer.id],
			name: "events_event_organizer_ref_id_6162f247_fk_events_organizer_id"
		}),
	foreignKey({
			columns: [table.searchQueryId],
			foreignColumns: [eventsSearchquery.id],
			name: "events_event_search_query_id_32555112_fk_events_searchquery_id"
		}),
	unique("events_event_slug_key").on(table.slug),
]);

export const eventsSearchquery = pgTable("events_searchquery", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "events_searchquery_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	query: varchar({ length: 500 }).notNull(),
	source: varchar({ length: 120 }).notNull(),
	isActive: boolean("is_active").notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	eventsFoundCount: integer("events_found_count").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("events_searchquery_is_active_4a99a794").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
	unique("unique_source_query").on(table.source, table.query),
]);

export const eventsScraperrun = pgTable("events_scraperrun", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "events_scraperrun_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	scraperKey: varchar("scraper_key", { length: 120 }).notNull(),
	status: varchar({ length: 20 }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	createdCount: integer("created_count").notNull(),
	updatedCount: integer("updated_count").notNull(),
	extraCounts: jsonb("extra_counts").notNull(),
	errorMessage: text("error_message").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	triggeredById: integer("triggered_by_id"),
	pid: integer(),
	logOutput: text("log_output").notNull(),
}, (table) => [
	index("events_scraperrun_scraper_key_671ad7a7").using("btree", table.scraperKey.asc().nullsLast().op("text_ops")),
	index("events_scraperrun_scraper_key_671ad7a7_like").using("btree", table.scraperKey.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_scraperrun_status_4d2f1125").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("events_scraperrun_status_4d2f1125_like").using("btree", table.status.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_scraperrun_triggered_by_id_0e0b19fc").using("btree", table.triggeredById.asc().nullsLast().op("int4_ops")),
	uniqueIndex("unique_active_scraper_run").using("btree", table.scraperKey.asc().nullsLast().op("text_ops")).where(sql`((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[]))`),
	foreignKey({
			columns: [table.triggeredById],
			foreignColumns: [authUser.id],
			name: "events_scraperrun_triggered_by_id_0e0b19fc_fk_auth_user_id"
		}),
	check("events_scraperrun_pid_check", sql`pid >= 0`),
]);

export const eventsOrganizer = pgTable("events_organizer", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "events_organizer_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	name: varchar({ length: 255 }).notNull(),
	slug: varchar({ length: 255 }).notNull(),
	status: varchar({ length: 20 }).notNull(),
	website: varchar({ length: 200 }).notNull(),
	email: varchar({ length: 254 }).notNull(),
	phone: varchar({ length: 80 }).notNull(),
	address: varchar({ length: 500 }).notNull(),
	city: varchar({ length: 120 }).notNull(),
	country: varchar({ length: 120 }).notNull(),
	facebookUrl: varchar("facebook_url", { length: 200 }).notNull(),
	instagramUrl: varchar("instagram_url", { length: 200 }).notNull(),
	description: text().notNull(),
	source: varchar({ length: 120 }).notNull(),
	sourceUrl: varchar("source_url", { length: 200 }).notNull(),
	externalId: varchar("external_id", { length: 255 }).notNull(),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	enrichedAt: timestamp("enriched_at", { withTimezone: true, mode: 'string' }),
	enrichmentSource: varchar("enrichment_source", { length: 120 }).notNull(),
}, (table) => [
	index("events_organizer_external_id_b6e38bba").using("btree", table.externalId.asc().nullsLast().op("text_ops")),
	index("events_organizer_external_id_b6e38bba_like").using("btree", table.externalId.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_organizer_slug_d270e2a4_like").using("btree", table.slug.asc().nullsLast().op("varchar_pattern_ops")),
	index("events_organizer_status_7939e7fb").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("events_organizer_status_7939e7fb_like").using("btree", table.status.asc().nullsLast().op("varchar_pattern_ops")),
	uniqueIndex("unique_organizer_source_external_id").using("btree", table.source.asc().nullsLast().op("text_ops"), table.externalId.asc().nullsLast().op("text_ops")).where(sql`((external_id)::text > ''::text)`),
	unique("events_organizer_slug_key").on(table.slug),
]);
