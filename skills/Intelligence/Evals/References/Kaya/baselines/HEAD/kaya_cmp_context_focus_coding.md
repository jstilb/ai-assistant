📋 SUMMARY: Debugging JWT refresh token authentication issue returning 401

I need to see your authentication middleware code to help debug this. Could you please share:

1. **The refresh endpoint handler** (where the 401 is being returned)
2. **Your JWT validation/verification logic** 
3. **How refresh tokens are stored and retrieved**
4. **Example request/response** (sanitized tokens OK)

Common causes of this issue:
- Refresh token expired or invalidated
- Token verification using wrong secret (access secret vs refresh secret)
- Refresh token not being extracted correctly from request
- Database/storage lookup failing for the refresh token
- Token blacklist blocking valid refresh tokens

Once I see the code, I can identify the specific issue and provide a fix.

🗣️ **Kaya**: Need to see refresh endpoint code, JWT verification logic, and token storage to debug the 401 error.