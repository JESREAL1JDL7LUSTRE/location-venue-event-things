import { relations } from "drizzle-orm/relations";
import { djangoContentType, authPermission, authGroup, authGroupPermissions, authUser, authUserGroups, authUserUserPermissions, djangoAdminLog, eventsVenue, eventsEvent, eventsOrganizer, eventsSearchquery, eventsScraperrun } from "./schema";

export const authPermissionRelations = relations(authPermission, ({one, many}) => ({
	djangoContentType: one(djangoContentType, {
		fields: [authPermission.contentTypeId],
		references: [djangoContentType.id]
	}),
	authGroupPermissions: many(authGroupPermissions),
	authUserUserPermissions: many(authUserUserPermissions),
}));

export const djangoContentTypeRelations = relations(djangoContentType, ({many}) => ({
	authPermissions: many(authPermission),
	djangoAdminLogs: many(djangoAdminLog),
}));

export const authGroupPermissionsRelations = relations(authGroupPermissions, ({one}) => ({
	authGroup: one(authGroup, {
		fields: [authGroupPermissions.groupId],
		references: [authGroup.id]
	}),
	authPermission: one(authPermission, {
		fields: [authGroupPermissions.permissionId],
		references: [authPermission.id]
	}),
}));

export const authGroupRelations = relations(authGroup, ({many}) => ({
	authGroupPermissions: many(authGroupPermissions),
	authUserGroups: many(authUserGroups),
}));

export const authUserGroupsRelations = relations(authUserGroups, ({one}) => ({
	authUser: one(authUser, {
		fields: [authUserGroups.userId],
		references: [authUser.id]
	}),
	authGroup: one(authGroup, {
		fields: [authUserGroups.groupId],
		references: [authGroup.id]
	}),
}));

export const authUserRelations = relations(authUser, ({many}) => ({
	authUserGroups: many(authUserGroups),
	authUserUserPermissions: many(authUserUserPermissions),
	djangoAdminLogs: many(djangoAdminLog),
	eventsScraperruns: many(eventsScraperrun),
}));

export const authUserUserPermissionsRelations = relations(authUserUserPermissions, ({one}) => ({
	authUser: one(authUser, {
		fields: [authUserUserPermissions.userId],
		references: [authUser.id]
	}),
	authPermission: one(authPermission, {
		fields: [authUserUserPermissions.permissionId],
		references: [authPermission.id]
	}),
}));

export const djangoAdminLogRelations = relations(djangoAdminLog, ({one}) => ({
	djangoContentType: one(djangoContentType, {
		fields: [djangoAdminLog.contentTypeId],
		references: [djangoContentType.id]
	}),
	authUser: one(authUser, {
		fields: [djangoAdminLog.userId],
		references: [authUser.id]
	}),
}));

export const eventsEventRelations = relations(eventsEvent, ({one}) => ({
	eventsVenue: one(eventsVenue, {
		fields: [eventsEvent.venueId],
		references: [eventsVenue.id]
	}),
	eventsOrganizer: one(eventsOrganizer, {
		fields: [eventsEvent.organizerRefId],
		references: [eventsOrganizer.id]
	}),
	eventsSearchquery: one(eventsSearchquery, {
		fields: [eventsEvent.searchQueryId],
		references: [eventsSearchquery.id]
	}),
}));

export const eventsVenueRelations = relations(eventsVenue, ({many}) => ({
	eventsEvents: many(eventsEvent),
}));

export const eventsOrganizerRelations = relations(eventsOrganizer, ({many}) => ({
	eventsEvents: many(eventsEvent),
}));

export const eventsSearchqueryRelations = relations(eventsSearchquery, ({many}) => ({
	eventsEvents: many(eventsEvent),
}));

export const eventsScraperrunRelations = relations(eventsScraperrun, ({one}) => ({
	authUser: one(authUser, {
		fields: [eventsScraperrun.triggeredById],
		references: [authUser.id]
	}),
}));